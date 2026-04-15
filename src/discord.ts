import {
	Client,
	EmbedBuilder,
	Events,
	GatewayIntentBits,
	REST,
	Routes,
	SlashCommandBuilder,
} from "discord.js";
import { processRequest } from "./ai.ts";
import { env } from "./env.ts";

export function createClient(): Client {
	return new Client({
		intents: [
			GatewayIntentBits.Guilds,
			GatewayIntentBits.GuildMessages,
			GatewayIntentBits.MessageContent,
		],
	});
}

export async function registerCommands(clientId: string): Promise<void> {
	const rest = new REST().setToken(env.DISCORD_TOKEN);
	const command = new SlashCommandBuilder()
		.setName("create-issue")
		.setDescription("Cria uma issue no GitHub a partir de uma descrição")
		.addStringOption((opt) =>
			opt
				.setName("description")
				.setDescription("Descreva o problema ou funcionalidade")
				.setRequired(true),
		)
		.addAttachmentOption((opt) =>
			opt
				.setName("image")
				.setDescription("Imagem opcional para anexar à issue"),
		);
	await rest.put(Routes.applicationCommands(clientId), {
		body: [command.toJSON()],
	});
}

function buildActionEmbed(title: string, body?: string, url?: string): EmbedBuilder {
	const embed = new EmbedBuilder().setTitle(title).setColor(0x2da44e);
	if (body) {
		const preview = body.length > 300 ? `${body.slice(0, 300)}...` : body;
		embed.setDescription(preview);
	}
	if (url) embed.setURL(url);
	return embed;
}

function buildListEmbed(title: string, body: string): EmbedBuilder {
	const preview = body.length > 4000 ? `${body.slice(0, 4000)}...` : body;
	return new EmbedBuilder().setTitle(title).setDescription(preview).setColor(0x2da44e);
}

interface RequestContext {
	content: string;
	imageUrls: string[];
	sendTyping: () => Promise<void>;
	sendMessage: (text: string) => Promise<void>;
	sendEmbed: (embed: EmbedBuilder) => Promise<void>;
}

async function handleRequest(ctx: RequestContext): Promise<void> {
	await ctx.sendTyping();
	const result = await processRequest(ctx.content, ctx.imageUrls);
	switch (result.type) {
		case "action":
			await ctx.sendEmbed(buildActionEmbed(result.title, result.body, result.url));
			break;
		case "list":
			await ctx.sendEmbed(buildListEmbed(result.title, result.body));
			break;
		case "refused":
			await ctx.sendMessage(result.reason);
			break;
	}
}

export function setupEvents(client: Client): void {
	client.on(Events.MessageCreate, async (message) => {
		if (message.author.bot) return;
		if (!message.mentions.has(client.user ?? "")) return;

		const userNote = message.content
			.replace(`<@${client.user?.id}>`, "")
			.trim();

		let content: string;
		const imageUrls: string[] = [];

		if (message.reference) {
			const referenced = await message.fetchReference().catch(() => null);
			if (referenced) {
				content = [
					`Mensagem original: ${referenced.content}`,
					userNote ? `Nota do usuário: ${userNote}` : null,
				]
					.filter(Boolean)
					.join("\n");
				imageUrls.push(
					...[...referenced.attachments.values(), ...message.attachments.values()]
						.filter((a) => a.contentType?.startsWith("image/"))
						.map((a) => a.url),
				);
			} else {
				content = userNote;
				imageUrls.push(
					...[...message.attachments.values()]
						.filter((a) => a.contentType?.startsWith("image/"))
						.map((a) => a.url),
				);
			}
		} else {
			if (!userNote) return;
			content = userNote;
			imageUrls.push(
				...[...message.attachments.values()]
					.filter((a) => a.contentType?.startsWith("image/"))
					.map((a) => a.url),
			);
		}

		try {
			await handleRequest({
				content,
				imageUrls,
				sendTyping: () => message.channel.sendTyping(),
				sendMessage: async (text) => {
					await message.reply({
						content: text,
						allowedMentions: { repliedUser: false },
					});
				},
				sendEmbed: async (embed) => {
					await message.reply({
						embeds: [embed],
						allowedMentions: { repliedUser: false },
					});
				},
			});
		} catch {
			await message.reply({
				content: "Não foi possível processar a solicitação. Tente novamente.",
				allowedMentions: { repliedUser: false },
			});
		}
	});

	client.on(Events.InteractionCreate, async (interaction) => {
		if (!interaction.isChatInputCommand()) return;
		if (interaction.commandName !== "create-issue") return;

		await interaction.deferReply();
		const content = interaction.options.getString("description", true);
		const attachment = interaction.options.getAttachment("image");
		const imageUrls = attachment?.contentType?.startsWith("image/")
			? [attachment.url]
			: [];

		try {
			await handleRequest({
				content,
				imageUrls,
				sendTyping: () => Promise.resolve(),
				sendMessage: async (text) => {
					await interaction.editReply(text);
				},
				sendEmbed: async (embed) => {
					await interaction.editReply({ embeds: [embed] });
				},
			});
		} catch {
			await interaction.editReply(
				"Não foi possível criar a issue. Tente novamente.",
			);
		}
	});
}
