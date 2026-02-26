import {
	Client,
	EmbedBuilder,
	Events,
	GatewayIntentBits,
	REST,
	Routes,
	SlashCommandBuilder,
} from "discord.js";
import { analyzeContent } from "./ai.ts";
import { env } from "./env.ts";
import { createIssue } from "./github.ts";

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
			opt.setName("image").setDescription("Imagem opcional para anexar à issue"),
		);
	await rest.put(Routes.applicationCommands(clientId), {
		body: [command.toJSON()],
	});
}

function buildSuccessEmbed(
	title: string,
	description: string,
	url: string,
	number: number,
): EmbedBuilder {
	const preview =
		description.length > 300 ? `${description.slice(0, 300)}...` : description;
	return new EmbedBuilder()
		.setTitle(title)
		.setDescription(preview)
		.setURL(url)
		.setColor(0x2da44e)
		.setFooter({ text: `Issue #${number}` });
}

interface IssueContext {
	content: string;
	imageUrls?: string[];
	sendTyping: () => Promise<void>;
	sendMessage: (text: string) => Promise<void>;
	sendEmbed: (embed: EmbedBuilder) => Promise<void>;
}

async function handleIssueCreation(ctx: IssueContext): Promise<void> {
	await ctx.sendTyping();
	const decision = await analyzeContent(ctx.content);

	if (decision.action === "refuse") {
		await ctx.sendMessage(decision.refusalReason);
		return;
	}

	const { url, number } = await createIssue(
		decision.title,
		decision.description,
		ctx.imageUrls,
	);
	await ctx.sendEmbed(
		buildSuccessEmbed(decision.title, decision.description, url, number),
	);
}

export function setupEvents(client: Client): void {
	client.on(Events.MessageCreate, async (message) => {
		if (message.author.bot) return;
		if (!message.mentions.has(client.user ?? "")) return;
		if (!message.reference) return;

		try {
			const referenced = await message.fetchReference();
			const userNote = message.content
				.replace(`<@${client.user?.id}>`, "")
				.trim();
			const content = [
				`Mensagem original: ${referenced.content}`,
				userNote ? `Nota do usuário: ${userNote}` : null,
			]
				.filter(Boolean)
				.join("\n");

			const imageUrls = [
				...referenced.attachments.values(),
				...message.attachments.values(),
			]
				.filter((a) => a.contentType?.startsWith("image/"))
				.map((a) => a.url);

			await handleIssueCreation({
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
				content: "Não foi possível criar a issue. Tente novamente.",
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
			await handleIssueCreation({
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
