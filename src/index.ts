import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// Define our MCP agent with tools
export class MyMCP extends McpAgent {
	server = new McpServer({
		name: "Authless Calculator",
		version: "1.0.0",
	});

	async init() {
		// Simple addition tool
		this.server.tool(
			"add",
			{ a: z.number(), b: z.number() },
			async ({ a, b }) => ({
				content: [{ type: "text", text: String(a + b) }],
			})
		);

		// Calculator tool with multiple operations
		this.server.tool(
			"calculate",
			{
				operation: z.enum(["add", "subtract", "multiply", "divide"]),
				a: z.number(),
				b: z.number(),
			},
			async ({ operation, a, b }) => {
				let result: number;
				switch (operation) {
					case "add":
						result = a + b;
						break;
					case "subtract":
						result = a - b;
						break;
					case "multiply":
						result = a * b;
						break;
					case "divide":
						if (b === 0)
							return {
								content: [
									{
										type: "text",
										text: "Error: Cannot divide by zero",
									},
								],
							};
						result = a / b;
						break;
				}
				return { content: [{ type: "text", text: String(result) }] };
			}
		);

		// Add todo tool that calls external API
		this.server.tool(
			"add_todo",
			{
				title: z.string().describe("The title of the todo item"),
				note: z.string().optional().describe("Optional note for the todo item"),
			},
			async ({ title, note }) => {
				try {
					// Generate current date and time
					const now = new Date();
					
					// Format date as YYYY/MM/DD
					const date = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')}`;
					
					// Format start time as HH:MM AM/PM
					const startTime = now.toLocaleTimeString('en-US', {
						hour: '2-digit',
						minute: '2-digit',
						hour12: true
					});
					
					// Calculate end time (start time + 15 minutes)
					const endDate = new Date(now.getTime() + 15 * 60 * 1000);
					const endTime = endDate.toLocaleTimeString('en-US', {
						hour: '2-digit',
						minute: '2-digit',
						hour12: true
					});

					// Prepare request body
					const requestBody = {
						title,
						note: note || "",
						date,
						startTime,
						endTime
					};

					// Call the external API
					const response = await fetch("https://2s627cz5fiowa22mehsoxahboq0pibpv.lambda-url.us-west-2.on.aws/tasks", {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
						},
						body: JSON.stringify(requestBody),
					});

					if (!response.ok) {
						return {
							content: [
								{
									type: "text",
									text: `Error: Failed to create todo. Status: ${response.status}`,
								},
							],
						};
					}

					const result = await response.text();
					return {
						content: [
							{
								type: "text",
								text: `Todo created successfully! Response: ${result}`,
							},
						],
					};
				} catch (error) {
					return {
						content: [
							{
								type: "text",
								text: `Error: Failed to create todo - ${error instanceof Error ? error.message : 'Unknown error'}`,
							},
						],
					};
				}
			}
		);
	}
}

export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const url = new URL(request.url);

		if (url.pathname === "/sse" || url.pathname === "/sse/message") {
			return MyMCP.serveSSE("/sse").fetch(request, env, ctx);
		}

		if (url.pathname === "/mcp") {
			return MyMCP.serve("/mcp").fetch(request, env, ctx);
		}

		return new Response("Not found", { status: 404 });
	},
};
