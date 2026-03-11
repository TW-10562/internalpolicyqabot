import { MCPClientWrapper, ServerConfig } from "@/clients/mcp";
import fs from "fs";
import path from "path";

export class MCPManager {
  private client = new MCPClientWrapper();

  static getOpenServers(): ServerConfig[] {
    const filePath = path.join(process.cwd(), "mcp-servers.json");
    const raw = fs.readFileSync(filePath, "utf-8");
    const json = JSON.parse(raw);

    return Object.entries(json.mcpServers).map(([name, config]: [string, any]) => ({
      name,
      type: config.type,
      url: config.url,
      command: config.command,
      isOpen: true
    }));
  }

  async connectAll(): Promise<void> {
    const servers = MCPManager.getOpenServers();
    for (const server of servers) {
      try {
        await this.client.connect(server);
      } catch (err) {
        console.error(`Failed to connect to ${server.name}:`, err);
      }
    }
  }

  getClient(): MCPClientWrapper {
    return this.client;
  }
}

let instance: MCPManager;
export function getMCPManager(): MCPManager {
  if (!instance) {
    instance = new MCPManager();
  }
  return instance;
}