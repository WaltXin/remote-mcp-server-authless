interface CognitoUserInfo {
	sub: string;
	email?: string;
	email_verified?: boolean;
	name?: string;
	given_name?: string;
	family_name?: string;
}

interface CognitoTokenResponse {
	access_token: string;
	token_type: string;
	expires_in: number;
	id_token?: string;
	refresh_token?: string;
}

interface ClientRegistration {
	redirect_uris?: string[];
	client_name?: string;
	scope?: string;
	grant_types?: string[];
	response_types?: string[];
}

// Simple in-memory store for registered clients (in production, use a database)
const registeredClients = new Map<string, any>();

export default {
	async fetch(request: Request, env: any): Promise<Response> {
		const url = new URL(request.url);

		// Handle dynamic client registration
		if (url.pathname === "/register") {
			return this.handleRegister(request, env);
		}

		// Handle token exchange
		if (url.pathname === "/token") {
			return this.handleToken(request, env);
		}

		// Handle OAuth callback from Cognito
		if (url.pathname === "/callback") {
			return this.handleCallback(request, env);
		}

		// Handle authorization initiation
		if (url.pathname === "/authorize") {
			return this.handleAuthorize(request, env);
		}

		// Default response for the root path
		return new Response("AWS Cognito OAuth Handler", { status: 200 });
	},

	async handleRegister(request: Request, env: any): Promise<Response> {
		if (request.method !== "POST") {
			return new Response("Method not allowed", { status: 405 });
		}

		try {
			const registration = await request.json() as ClientRegistration;
			
			// Generate a client ID for the MCP client
			const clientId = `mcp_client_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
			
			// Store client registration (in production, use a database)
			registeredClients.set(clientId, {
				client_id: clientId,
				redirect_uris: registration.redirect_uris || [],
				client_name: registration.client_name || "MCP Client",
				scope: registration.scope || "openid profile email",
				grant_types: registration.grant_types || ["authorization_code"],
				response_types: registration.response_types || ["code"],
				token_endpoint_auth_method: "none",
				created_at: Date.now()
			});

			return new Response(
				JSON.stringify({
					client_id: clientId,
					client_id_issued_at: Math.floor(Date.now() / 1000),
					redirect_uris: registration.redirect_uris || [],
					grant_types: ["authorization_code"],
					response_types: ["code"],
					token_endpoint_auth_method: "none",
					scope: "openid profile email"
				}),
				{
					status: 201,
					headers: { "Content-Type": "application/json" },
				}
			);
		} catch (error) {
			return new Response("Invalid registration request", { status: 400 });
		}
	},

	async handleToken(request: Request, env: any): Promise<Response> {
		if (request.method !== "POST") {
			return new Response("Method not allowed", { status: 405 });
		}

		try {
			const body = await request.text();
			const params = new URLSearchParams(body);
			
			const grantType = params.get("grant_type");
			const code = params.get("code");
			const clientId = params.get("client_id");
			const codeVerifier = params.get("code_verifier");
			const redirectUri = params.get("redirect_uri");

			if (grantType !== "authorization_code" || !code || !clientId) {
				return new Response(
					JSON.stringify({ error: "invalid_request" }),
					{ status: 400, headers: { "Content-Type": "application/json" } }
				);
			}

			// Verify client is registered
			const client = registeredClients.get(clientId);
			if (!client) {
				return new Response(
					JSON.stringify({ error: "invalid_client" }),
					{ status: 401, headers: { "Content-Type": "application/json" } }
				);
			}

			// Decode the auth code to get user info (this is our simple implementation)
			let userInfo;
			try {
				userInfo = JSON.parse(atob(code));
			} catch (error) {
				return new Response(
					JSON.stringify({ error: "invalid_grant" }),
					{ status: 400, headers: { "Content-Type": "application/json" } }
				);
			}

			// Generate access token (in production, use proper JWT)
			const accessToken = `mcp_token_${Date.now()}_${Math.random().toString(36).substr(2, 16)}`;
			
			// Store token mapping (in production, use a database with expiration)
			const tokenData = {
				access_token: accessToken,
				user_info: userInfo,
				client_id: clientId,
				scope: "openid profile email",
				expires_at: Date.now() + (3600 * 1000) // 1 hour
			};

			return new Response(
				JSON.stringify({
					access_token: accessToken,
					token_type: "Bearer",
					expires_in: 3600,
					scope: "openid profile email"
				}),
				{
					headers: { "Content-Type": "application/json" },
				}
			);
		} catch (error) {
			return new Response(
				JSON.stringify({ error: "server_error" }),
				{ status: 500, headers: { "Content-Type": "application/json" } }
			);
		}
	},

	async handleAuthorize(request: Request, env: any): Promise<Response> {
		const url = new URL(request.url);
		const clientId = url.searchParams.get("client_id");
		const redirectUri = url.searchParams.get("redirect_uri");
		const state = url.searchParams.get("state");
		const scopes = url.searchParams.get("scope") || "openid email profile";
		const codeChallenge = url.searchParams.get("code_challenge");
		const codeChallengeMethod = url.searchParams.get("code_challenge_method");

		if (!clientId || !redirectUri) {
			return new Response("Missing required parameters", { status: 400 });
		}

		// Verify client is registered
		const client = registeredClients.get(clientId);
		if (!client) {
			return new Response("Invalid client", { status: 401 });
		}

		// Construct Cognito authorization URL
		const cognitoAuthUrl = new URL("https://zimitechs-gen2.auth.us-west-2.amazoncognito.com/oauth2/authorize");
		cognitoAuthUrl.searchParams.set("client_id", env.COGNITO_CLIENT_ID);
		cognitoAuthUrl.searchParams.set("response_type", "code");
		cognitoAuthUrl.searchParams.set("scope", scopes);
		cognitoAuthUrl.searchParams.set("redirect_uri", `${url.origin}/callback`);
		
		// Include original state and redirect info in Cognito state
		const cognitoState = JSON.stringify({
			originalState: state,
			originalRedirectUri: redirectUri,
			originalClientId: clientId,
			codeChallenge,
			codeChallengeMethod
		});
		cognitoAuthUrl.searchParams.set("state", cognitoState);

		// Redirect to Cognito
		return Response.redirect(cognitoAuthUrl.toString(), 302);
	},

	async handleCallback(request: Request, env: any): Promise<Response> {
		const url = new URL(request.url);
		const code = url.searchParams.get("code");
		const state = url.searchParams.get("state");
		const error = url.searchParams.get("error");

		if (error) {
			return new Response(`OAuth error: ${error}`, { status: 400 });
		}

		if (!code || !state) {
			return new Response("Missing authorization code or state", { status: 400 });
		}

		try {
			// Parse the state to get original redirect info
			const stateData = JSON.parse(state);
			const { originalRedirectUri, originalClientId, originalState } = stateData;

			// Exchange code for tokens
			const tokenResponse = await this.exchangeCodeForTokens(code, url.origin, env);
			
			// Get user info
			const userInfo = await this.getUserInfo(tokenResponse.access_token, env);

			// Create the final authorization code for the MCP client
			const finalAuthCode = await this.createMCPAuthCode(userInfo, env);

			// Redirect back to the original client
			const finalRedirectUrl = new URL(originalRedirectUri);
			finalRedirectUrl.searchParams.set("code", finalAuthCode);
			if (originalState) {
				finalRedirectUrl.searchParams.set("state", originalState);
			}

			return Response.redirect(finalRedirectUrl.toString(), 302);
		} catch (error) {
			console.error("OAuth callback error:", error);
			return new Response("OAuth callback failed", { status: 500 });
		}
	},

	async exchangeCodeForTokens(code: string, origin: string, env: any): Promise<CognitoTokenResponse> {
		const tokenUrl = "https://zimitechs-gen2.auth.us-west-2.amazoncognito.com/oauth2/token";
		
		const params = new URLSearchParams({
			grant_type: "authorization_code",
			client_id: env.COGNITO_CLIENT_ID,
			client_secret: env.COGNITO_CLIENT_SECRET,
			code: code,
			redirect_uri: `${origin}/callback`,
		});

		const response = await fetch(tokenUrl, {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: params.toString(),
		});

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(`Token exchange failed: ${response.status} ${errorText}`);
		}

		return await response.json();
	},

	async getUserInfo(accessToken: string, env: any): Promise<CognitoUserInfo> {
		const userInfoUrl = "https://zimitechs-gen2.auth.us-west-2.amazoncognito.com/oauth2/userInfo";
		
		const response = await fetch(userInfoUrl, {
			headers: {
				Authorization: `Bearer ${accessToken}`,
			},
		});

		if (!response.ok) {
			throw new Error(`User info request failed: ${response.status}`);
		}

		return await response.json();
	},

	async createMCPAuthCode(userInfo: CognitoUserInfo, env: any): Promise<string> {
		// Create a simple auth code containing user info
		// In production, you might want to store this in a database and return a reference
		const authData = {
			sub: userInfo.sub,
			email: userInfo.email,
			name: userInfo.name || userInfo.given_name || userInfo.email,
			timestamp: Date.now(),
		};
		
		// Simple base64 encoding for demo purposes
		// In production, consider using JWT or storing in a database
		return btoa(JSON.stringify(authData));
	},
}; 