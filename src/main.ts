import { Events } from "discord.js";
import { createClient, registerCommands, setupEvents } from "./discord.ts";
import { env } from "./env.ts";

const client = createClient();

client.once(Events.ClientReady, async () => {
	console.log(`Bot connected as ${client.user?.tag}`);
	await registerCommands(client.user?.id ?? "");
	console.log("Slash commands registered");
});

setupEvents(client);
await client.login(env.DISCORD_TOKEN);
