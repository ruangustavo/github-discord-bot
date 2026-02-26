import { openai } from "@ai-sdk/openai";
import { generateText, tool } from "ai";
import { z } from "zod";
import { addComment, createIssue, getIssue } from "./github.ts";

const model = openai("gpt-4o-mini");

const SYSTEM_PROMPT = `Você é um bot de gerenciamento de issues no GitHub. Com base na mensagem do usuário, chame a ferramenta adequada:

- **create_issue**: use para QUALQUER conteúdo acionável (bug, funcionalidade, problema, dúvida, etc.). Esta é a ação PADRÃO.
- **add_comment**: use SOMENTE quando o usuário disser EXPLICITAMENTE que quer "adicionar comentário", "comentar" ou equivalente em uma issue E fornecer o número dela.

Se o conteúdo for completamente fora do escopo ou vago demais para qualquer ação, responda apenas com texto explicando o motivo — sem chamar nenhuma ferramenta.

Ao criar uma issue: gere título conciso e descrição sucinta em Markdown, ambos em português. Reorganize as ideias do usuário sem expandir o escopo — não adicione contexto, sugestões ou seções que o usuário não mencionou.
Ao adicionar comentário: escreva o corpo em Markdown em português, usando verbos no infinitivo — os comentários representam ações futuras (ex: "Adicionar suporte a X", "Corrigir comportamento Y"). Se a mensagem não tiver texto (apenas imagem), o corpo pode ser vazio ou uma frase mínima de contexto.`;

export type RequestResult =
	| {
			type: "issue_created";
			title: string;
			description: string;
			url: string;
			number: number;
	  }
	| {
			type: "comment_added";
			issueTitle: string;
			url: string;
			issueNumber: number;
	  }
	| { type: "refused"; reason: string };

export async function processRequest(
	content: string,
	imageUrls: string[] = [],
): Promise<RequestResult> {
	let result: RequestResult | null = null;

	const imageContext =
		imageUrls.length > 0
			? `\n\n[${imageUrls.length} imagem(ns) anexada(s) como contexto adicional]`
			: "";

	const createIssueTool = tool({
		description: "Cria uma nova issue no GitHub com título e descrição",
		inputSchema: z.object({
			title: z.string().describe("Título claro e conciso da issue"),
			description: z
				.string()
				.describe("Descrição detalhada da issue em Markdown"),
		}),
		execute: async ({ title, description }) => {
			const { url, number } = await createIssue(title, description, imageUrls);
			result = { type: "issue_created", title, description, url, number };
			return { url, number };
		},
	});

	const addCommentTool = tool({
		description:
			"Adiciona um comentário a uma issue existente no GitHub. Usar SOMENTE quando o usuário explicitamente pedir para comentar em uma issue específica.",
		inputSchema: z.object({
			issueNumber: z
				.number()
				.describe("Número da issue onde o comentário será adicionado"),
			body: z.string().describe("Corpo do comentário em Markdown"),
		}),
		execute: async ({ issueNumber, body }) => {
			const issue = await getIssue(issueNumber);
			if (!issue) {
				result = {
					type: "refused",
					reason: `A issue #${issueNumber} não foi encontrada.`,
				};
				return { error: "not_found" };
			}
			const { url } = await addComment(issueNumber, body, imageUrls);
			result = {
				type: "comment_added",
				issueTitle: issue.title,
				url,
				issueNumber,
			};
			return { url };
		},
	});

	const { text } = await generateText({
		model,
		tools: {
			create_issue: createIssueTool,
			add_comment: addCommentTool,
		},
		system: SYSTEM_PROMPT,
		prompt: content + imageContext,
	});

	return (
		result ?? {
			type: "refused",
			reason:
				text ||
				"Não consigo processar essa solicitação. Por favor, forneça mais detalhes.",
		}
	);
}
