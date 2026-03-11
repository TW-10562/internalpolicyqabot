import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport, StdioServerParameters } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { homedir } from 'os';

export interface ServerConfig {
  name: string;
  type: 'command' | 'sse';
  command?: string;
  url?: string;
  isOpen?: boolean;
}

export class MCPClientWrapper {
  private sessions: Map<string, Client> = new Map();
  private transports: Map<string, StdioClientTransport | SSEClientTransport> = new Map();

  async connect(serverConfig: ServerConfig): Promise<void> {
    let transport: StdioClientTransport | SSEClientTransport;

    if (serverConfig.type === 'command' && serverConfig.command) {
      transport = await this.createCommandTransport(serverConfig.command);
    } else if (serverConfig.type === 'sse' && serverConfig.url) {
      transport = new SSEClientTransport(new URL(serverConfig.url));
    } else {
      throw new Error(`Invalid server configuration for: ${serverConfig.name}`);
    }

    const client = new Client(
      { name: "mcp-client", version: "1.0.0" },
      { capabilities: { prompts: {}, resources: {}, tools: {} } }
    );
    await client.connect(transport);

    this.sessions.set(serverConfig.name, client);
    this.transports.set(serverConfig.name, transport);

    const tools = await client.listTools();
    console.log(`Connected to '${serverConfig.name}':`, tools.tools.map((t: Tool) => t.name));
  }

  async listTools(serverName: string): Promise<Tool[]> {
    const session = this.sessions.get(serverName);
    if (!session) throw new Error(`No session for ${serverName}`);
    const { tools } = await session.listTools();
    return tools;
  }

  async callTool(serverName: string, toolName: string, args: any): Promise<any> {
    const session = this.sessions.get(serverName);
    if (!session) throw new Error(`No session for ${serverName}`);
    return session.callTool({ name: toolName, arguments: args });
  }

  getActiveSessions(): string[] {
    return [...this.sessions.keys()];
  }

  async cleanup(): Promise<void> {
    for (const transport of this.transports.values()) {
      await transport.close();
    }
    this.transports.clear();
    this.sessions.clear();
  }

  private async createCommandTransport(shell: string): Promise<StdioClientTransport> {
    const [command, ...shellArgs] = shell.split(' ');
    const args = shellArgs.map(arg => arg.replace(/^~\//, `${homedir()}/`));

    const serverParams: StdioServerParameters = {
      command,
      args,
      env: Object.fromEntries(Object.entries(process.env).filter(([_, v]) => v !== undefined)) as Record<string, string>
    };
    return new StdioClientTransport(serverParams);
  }
}