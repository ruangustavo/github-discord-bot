import { openai } from "@ai-sdk/openai";
import { generateText, Output } from "ai";
import { z } from "zod";

const model = openai("gpt-4o-mini");

const decisionSchema = z.object({
	action: z
		.enum(["create", "refuse"])
		.describe(
			"Ação a tomar: 'create' para criar a issue, 'refuse' para recusar conteúdo off-topic ou vago demais",
		),
	title: z
		.string()
		.nullable()
		.describe(
			"Título da issue. Obrigatório quando action='create', null caso contrário",
		),
	description: z
		.string()
		.nullable()
		.describe(
			"Descrição detalhada da issue em Markdown. Obrigatório quando action='create', null caso contrário",
		),
	refusalReason: z
		.string()
		.nullable()
		.describe(
			"Motivo da recusa. Obrigatório quando action='refuse', null caso contrário",
		),
});

export type CreateDecision = {
	action: "create";
	title: string;
	description: string;
};

export type RefuseDecision = { action: "refuse"; refusalReason: string };

export type Decision = CreateDecision | RefuseDecision;

const SYSTEM_PROMPT = `Crie issues no GitHub a partir do conteúdo fornecido.

- "create": conteúdo acionável → title e description curta e objetiva em português
- "refuse": off-topic ou vago demais → refusalReason em português

Campos não usados: null.`;

export async function analyzeContent(
	content: string,
	imageCount = 0,
): Promise<Decision> {
	const prompt =
		imageCount > 0
			? `${content}\n\n[${imageCount} imagem(ns) anexada(s) como contexto adicional]`
			: content;

	const { output: object } = await generateText({
		model,
		output: Output.object({ schema: decisionSchema }),
		system: SYSTEM_PROMPT,
		prompt,
	});

	if (object.action === "create" && object.title && object.description) {
		return {
			action: "create",
			title: object.title,
			description: object.description,
		};
	}

	if (object.action === "refuse" && object.refusalReason) {
		return { action: "refuse", refusalReason: object.refusalReason };
	}

	return {
		action: "refuse",
		refusalReason:
			"Não consigo processar essa solicitação. Por favor, forneça mais detalhes sobre o que precisa ser feito.",
	};
}
