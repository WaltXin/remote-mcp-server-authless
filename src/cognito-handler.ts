interface GoogleUserInfo {
	sub: string;
	email?: string;
	name?: string;
	given_name?: string;
	family_name?: string;
	picture?: string;
}

interface GoogleTokenResponse {
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

interface MCPTokenData {
	cognitoIdentityId: string;
	googleUserId: string;
	email: string;
	name: string;
	timestamp: number;
}

interface CognitoIdentityResponse {
	IdentityId: string;
}

// Function signature for createMCPAuthCode
interface CreateMCPAuthCodeInput {
	cognitoIdentityId: string;
	googleUserId: string;
	email: string;
	name: string;
}

// Simple in-memory store for registered clients (in production, use a database)
const registeredClients = new Map<string, any>();

// Simple in-memory token store (not suitable for production)
const tokenStore = new Map<string, MCPTokenData>();

export const cognitoHandler = {
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

		// Handle OAuth callback from Google
		if (url.pathname === "/callback") {
			return this.handleCallback(request, env);
		}

		// Handle authorization initiation
		if (url.pathname === "/authorize") {
			return this.handleAuthorize(request, env);
		}

		// Default response for the root path
		return new Response("Direct Google OAuth Handler", { status: 200 });
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

			if (grantType !== "authorization_code" || !code || !clientId) {
				return new Response(
					JSON.stringify({ error: "invalid_request" }),
					{ status: 400, headers: { "Content-Type": "application/json" } }
				);
			}

			// Decode the auth code to get token data
			let tokenData: MCPTokenData;
			try {
				tokenData = JSON.parse(atob(code));
			} catch (error) {
				return new Response(
					JSON.stringify({ error: "invalid_grant" }),
					{ status: 400, headers: { "Content-Type": "application/json" } }
				);
			}

			// Generate MCP access token
			const accessToken = `mcp_token_${Date.now()}_${Math.random().toString(36).substr(2, 16)}`;
			
			// Store token mapping for later verification
			tokenStore.set(accessToken, tokenData);

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
		const codeChallenge = url.searchParams.get("code_challenge");
		const codeChallengeMethod = url.searchParams.get("code_challenge_method");

		if (!clientId || !redirectUri) {
			return new Response("Missing required parameters", { status: 400 });
		}

		// Calculate the actual redirect URI we'll use
		const actualRedirectUri = `${url.origin}/callback`;
		console.log("=== OAuth Debug Info ===");
		console.log("Request origin:", url.origin);
		console.log("Actual redirect URI:", actualRedirectUri);
		console.log("Google Client ID:", env.GOOGLE_CLIENT_ID);

		// Construct Google OAuth URL (DIRECT TO GOOGLE)
		const googleAuthUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
		googleAuthUrl.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
		googleAuthUrl.searchParams.set("response_type", "code");
		googleAuthUrl.searchParams.set("scope", "openid email profile");
		googleAuthUrl.searchParams.set("redirect_uri", actualRedirectUri);
		
		// Store original MCP client info in state
		const googleState = JSON.stringify({
			mcpClientId: clientId,
			mcpRedirectUri: redirectUri,
			mcpState: state,
			codeChallenge,
			codeChallengeMethod
		});
		googleAuthUrl.searchParams.set("state", googleState);

		console.log("Final Google Auth URL:", googleAuthUrl.toString());
		console.log("========================");

		// Redirect directly to Google
		return Response.redirect(googleAuthUrl.toString(), 302);
	},

	async handleCallback(request: Request, env: any): Promise<Response> {
		const url = new URL(request.url);
		const code = url.searchParams.get("code");
		const state = url.searchParams.get("state");
		const error = url.searchParams.get("error");

		console.log("=== OAuth Callback Debug ===");
		console.log("Callback URL:", url.toString());
		console.log("Has code:", !!code);
		console.log("Has state:", !!state);
		console.log("Has error:", !!error);

		if (error) {
			console.error("Google OAuth error:", error);
			return new Response(`Google OAuth error: ${error}`, { status: 400 });
		}

		if (!code || !state) {
			console.error("Missing authorization code or state");
			return new Response("Missing authorization code or state", { status: 400 });
		}

		try {
			// Parse the state to get original MCP client info
			const stateData = JSON.parse(state);
			const { mcpClientId, mcpRedirectUri, mcpState } = stateData;
			console.log("Parsed state data:", { mcpClientId, mcpRedirectUri, mcpState });

			// Exchange code for Google tokens
			console.log("Exchanging code for Google tokens...");
			const googleTokens = await this.exchangeGoogleCodeForTokens(code, url.origin, env);
			console.log("Google tokens received, has id_token:", !!googleTokens.id_token);
			
			// Get user info from Google
			console.log("Getting Google user info...");
			const googleUserInfo = await this.getGoogleUserInfo(googleTokens.access_token);
			console.log("Google user info:", { sub: googleUserInfo.sub, email: googleUserInfo.email });

			// Get Cognito Identity ID using Google token
			console.log("Getting Cognito Identity ID...");
			const cognitoIdentityId = await this.getCognitoIdentityId(googleTokens.id_token!, env);
			console.log("Cognito Identity ID received:", cognitoIdentityId);

			// Create MCP auth code containing all user data
			const mcpAuthCode = await this.createMCPAuthCode({
				cognitoIdentityId,
				googleUserId: googleUserInfo.sub,
				email: googleUserInfo.email!,
				name: googleUserInfo.name || googleUserInfo.given_name || googleUserInfo.email!,
			});
			console.log("MCP auth code created, length:", mcpAuthCode.length);

			// Redirect back to the MCP client
			const finalRedirectUrl = new URL(mcpRedirectUri);
			finalRedirectUrl.searchParams.set("code", mcpAuthCode);
			if (mcpState) {
				finalRedirectUrl.searchParams.set("state", mcpState);
			}

			console.log("Redirecting to MCP client:", finalRedirectUrl.toString());
			console.log("============================");

			return Response.redirect(finalRedirectUrl.toString(), 302);
		} catch (error) {
			console.error("OAuth callback error:", error);
			console.error("Error stack:", error instanceof Error ? error.stack : 'No stack');
			return new Response(`OAuth callback failed: ${error}`, { status: 500 });
		}
	},

	async exchangeGoogleCodeForTokens(code: string, origin: string, env: any): Promise<GoogleTokenResponse> {
		const tokenUrl = "https://oauth2.googleapis.com/token";
		
		const params = new URLSearchParams({
			grant_type: "authorization_code",
			client_id: env.GOOGLE_CLIENT_ID,
			client_secret: env.GOOGLE_CLIENT_SECRET,
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
			throw new Error(`Google token exchange failed: ${response.status} ${errorText}`);
		}

		return await response.json();
	},

	async getGoogleUserInfo(accessToken: string): Promise<GoogleUserInfo> {
		const userInfoUrl = "https://www.googleapis.com/oauth2/v2/userinfo";
		
		const response = await fetch(userInfoUrl, {
			headers: {
				Authorization: `Bearer ${accessToken}`,
			},
		});

		if (!response.ok) {
			throw new Error(`Google user info request failed: ${response.status}`);
		}

		return await response.json();
	},

	async getCognitoIdentityId(googleIdToken: string, env: any): Promise<string> {
		console.log("=== Getting Cognito Identity ID ===");
		console.log("Identity Pool ID:", env.COGNITO_IDENTITY_POOL_ID);
		console.log("AWS Region:", env.AWS_REGION);
		console.log("Google ID Token length:", googleIdToken.length);

		try {
			// Call AWS Cognito Identity Pool using REST API
			const identityUrl = `https://cognito-identity.${env.AWS_REGION}.amazonaws.com/`;
			
			const getIdRequest = {
				IdentityPoolId: env.COGNITO_IDENTITY_POOL_ID,
				Logins: {
					"accounts.google.com": googleIdToken
				}
			};

			console.log("Calling Cognito GetId API...");
			const response = await fetch(identityUrl, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/x-amz-json-1.1',
					'X-Amz-Target': 'AWSCognitoIdentityService.GetId'
				},
				body: JSON.stringify(getIdRequest)
			});

			if (!response.ok) {
				const errorText = await response.text();
				console.error("Cognito GetId failed:", response.status, errorText);
				throw new Error(`Cognito GetId failed: ${response.status} ${errorText}`);
			}

			const result = await response.json() as CognitoIdentityResponse;
			console.log("Cognito GetId result:", result);

			if (!result.IdentityId) {
				throw new Error("Failed to get Cognito Identity ID from response");
			}

			console.log("Successfully got Cognito Identity ID:", result.IdentityId);
			return result.IdentityId;
		} catch (error) {
			console.error("Failed to get Cognito Identity ID:", error);
			console.error("Error details:", error instanceof Error ? error.stack : 'No stack');
			throw error;
		}
	},

	async createMCPAuthCode(tokenData: CreateMCPAuthCodeInput): Promise<string> {
		// Add timestamp for token validation
		const authData: MCPTokenData = {
			...tokenData,
			timestamp: Date.now(),
		};
		
		// Base64 encode the token data
		return btoa(JSON.stringify(authData));
	},

	// Helper function to verify MCP tokens
	verifyMCPToken(accessToken: string): MCPTokenData | null {
		return tokenStore.get(accessToken) || null;
	}
}; 