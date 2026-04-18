import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, VERSION } from "./server.js";

async function main(): Promise<void> {
  const apiKey = process.env.FAXDROP_API_KEY;

  if (!apiKey) {
    console.error("ERROR: FAXDROP_API_KEY environment variable is required.");
    console.error("Get your key at https://faxdrop.com/account (Developer API → Generate Key)");
    process.exit(1);
  }

  const server = createServer({
    apiKey,
    baseUrl: process.env.FAXDROP_API_BASE_URL,
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error(`faxdrop-mcp v${VERSION} running on stdio`);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
