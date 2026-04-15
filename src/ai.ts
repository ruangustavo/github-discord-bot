import { openai } from "@ai-sdk/openai";
import { hasToolCall, stepCountIs, ToolLoopAgent, tool } from "ai";
import { z } from "zod";
import { cache, isCacheValid } from "./cache.ts";
import { env } from "./env.ts";
import { createGitHubClient } from "./github.ts";

const model = openai("gpt-4o-mini");
const github = createGitHubClient(env.GH_TOKEN);

async function getCollaborators(): Promise<string[]> {
	if (cache.collaborators && isCacheValid(cache.collaborators))
		return cache.collaborators.data;

	const data = await github.fetchCollaborators(env.GITHUB_REPO);
	cache.collaborators = { data, fetchedAt: Date.now() };
	return data;
}

async function getLabels(): Promise<string[]> {
	if (cache.labels && isCacheValid(cache.labels)) return cache.labels.data;

	const data = await github.fetchLabels(env.GITHUB_REPO);
	cache.labels = { data, fetchedAt: Date.now() };
	return data;
}

async function getMilestones(): Promise<string[]> {
	if (cache.milestones && isCacheValid(cache.milestones))
		return cache.milestones.data;

	const data = await github.fetchMilestones(env.GITHUB_REPO);
	cache.milestones = { data, fetchedAt: Date.now() };
	return data;
}

function buildSystemPrompt(context: {
	collaborators: string[];
	labels: string[];
	milestones: string[];
}): string {
	const collaboratorsList =
		context.collaborators.length > 0
			? context.collaborators.join(", ")
			: "nenhum";

	const labelsList =
		context.labels.length > 0 ? context.labels.join(", ") : "nenhuma";

	const milestonesList =
		context.milestones.length > 0 ? context.milestones.join(", ") : "nenhum";

	return `Você é um agente de gerenciamento de issues no GitHub. Você tem acesso à ferramenta "gh" para executar comandos do GitHub CLI e à ferramenta "respond" para reportar o resultado final.

Contexto do repositório (${env.GITHUB_REPO}):
- Colaboradores: ${collaboratorsList}
- Labels: ${labelsList}
- Milestones: ${milestonesList}

Fluxo de trabalho:
1. Analise a mensagem do usuário.
2. Use a ferramenta "gh" quantas vezes precisar para executar a ação adequada.
3. Ao terminar, chame OBRIGATORIAMENTE a ferramenta "respond" com o resultado.

Formato de referência a issues:
- No campo "title": use texto simples com o número da issue, ex: "Issue #5 fechada", "Issue #7 criada". NÃO use markdown no title.
- No campo "body": SEMPRE referencie issues com link markdown: Texto [#N](URL). Ex: "Label 'bug' adicionada à issue [#3](https://github.com/owner/repo/issues/3)".
- "issue create" retorna { url, number } automaticamente. Para consultas, use --json url.

Formas de resposta:
- "action": algo foi feito (criar, fechar, reabrir, comentar, editar, atribuir, label, milestone, etc.).
  - title: título claro da ação em texto simples, ex: "Issue #5 fechada", "Label 'bug' adicionada à Issue #3", "Issue #7 criada".
  - body: opcional, use para o corpo da issue criada ou um resumo relevante em Markdown. Referencie issues com [#N](URL).
  - url: SEMPRE inclua a URL da issue quando disponível. O title inteiro se torna clicável através desse campo.
- "list": resultados de uma consulta (listar issues, labels, milestones, etc.).
  - title: nome da listagem, ex: "Issues abertas", "Labels disponíveis".
  - body: lista formatada em Markdown. Cada issue deve seguir o formato: Título da issue [#N](URL).
- "refused": conteúdo completamente fora do escopo de gerenciamento de issues no GitHub.
  - reason: motivo da recusa.

Regras:
- Criar issue é a ação PADRÃO para qualquer conteúdo acionável (bug, funcionalidade, problema, dúvida).
- Use os colaboradores, labels e milestones do contexto acima ao interpretar referências por nome.
- Ao criar uma issue: gere título conciso e descrição sucinta em Markdown, ambos em português. Reorganize as ideias sem expandir escopo.
- Recuse APENAS se o conteúdo for completamente fora do escopo de gerenciamento de issues.
- Se houver URLs de imagens na mensagem, inclua-as no corpo como markdown: ![image](URL)

Regras de eficiência:
- Combine TODOS os flags em uma ÚNICA chamada. Ex: ["issue", "create", "--title", "...", "--body", "...", "--assignee", "user", "--label", "bug"]
- "issue create" NÃO suporta --json. O resultado já retorna { url, number } automaticamente. NUNCA repita o comando de criação.
- Execute APENAS as ações solicitadas pelo usuário. NÃO invente ações adicionais (como comentários ou edições não pedidas).
- NUNCA execute ações em paralelo quando uma depende do resultado da outra. Ex: se precisa criar uma issue e depois comentar nela, PRIMEIRO crie a issue, AGUARDE o número retornado, e SÓ ENTÃO comente.
- Quando "gh issue close" retorna uma URL, a issue foi fechada com sucesso. NÃO verifique listando issues novamente. Após executar todas as ações, chame "respond" imediatamente.
- NUNCA liste issues para verificar se uma ação funcionou. Confie no resultado do comando.`;
}

export type RequestResult =
	| { type: "action"; title: string; body?: string; url?: string }
	| { type: "list"; title: string; body: string }
	| { type: "refused"; reason: string };

const ALLOWED_SUBCOMMANDS = ["issue", "label", "api"] as const;
type AllowedSubcommand = (typeof ALLOWED_SUBCOMMANDS)[number];

const LABEL_MUTATION_ACTIONS = ["create", "delete", "edit"] as const;
type LabelMutationAction = (typeof LABEL_MUTATION_ACTIONS)[number];

export async function processRequest(
	content: string,
	imageUrls: string[] = [],
): Promise<RequestResult> {
	const [collaborators, labels, milestones] = await Promise.all([
		getCollaborators(),
		getLabels(),
		getMilestones(),
	]);

	const systemPrompt = buildSystemPrompt({
		collaborators,
		labels,
		milestones,
	});

	const imageContext =
		imageUrls.length > 0
			? `\n\nImagens anexadas:\n${imageUrls.map((u) => `![image](${u})`).join("\n")}`
			: "";

	const ghTool = tool({
		description: `Executa comandos do GitHub CLI para gerenciamento de issues.
Subcomandos permitidos: "issue", "label", "api".
O --repo é injetado automaticamente em comandos "issue" e "label" — não inclua --repo nesses args.
Para "api", especifique o caminho completo (ex: repos/:owner/:repo/milestones).

Exemplos:
  ["issue", "list"]
  ["issue", "view", "42", "--json", "title,url"]
  ["issue", "create", "--title", "Bug: login", "--body", "Passos...", "--assignee", "user", "--label", "bug"]
  ["issue", "comment", "42", "--body", "Investigar na próxima sprint"]
  ["issue", "close", "42"]
  ["issue", "reopen", "42"]
  ["issue", "edit", "42", "--add-assignee", "ruangustavo", "--add-label", "bug"]
  ["issue", "edit", "42", "--milestone", "v1.0"]
  ["label", "list", "--json", "name", "--jq", ".[].name"]
  ["label", "create", "priority-high", "--color", "#e11d48"]
  ["api", "repos/:owner/:repo/milestones", "--jq", ".[].title"]
  ["api", "repos/:owner/:repo/milestones", "-f", "title=v2.0", "--method", "POST"]`,
		inputSchema: z.object({
			args: z
				.array(z.string())
				.describe(
					'Argumentos após "gh", ex: ["issue", "create", "--title", "..."]',
				),
		}),
		execute: async ({ args }) => {
			const subcommand = args[0] ?? "";
			const subaction = args[1] ?? "";
			if (!ALLOWED_SUBCOMMANDS.includes(subcommand as AllowedSubcommand)) {
				return {
					error: `Subcommand "${subcommand}" não permitido. Use apenas: ${ALLOWED_SUBCOMMANDS.join(", ")}.`,
				};
			}

			const cmd =
				subcommand === "api"
					? ["gh", ...args]
					: ["gh", ...args, "--repo", env.GITHUB_REPO];

			const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			if (exitCode !== 0) {
				return { error: stderr.trim() || `gh encerrou com código ${exitCode}` };
			}

			const output = stdout.trim();

			// Parse URL from issue create/close/reopen to return structured data
			if (
				subcommand === "issue" &&
				["create", "close", "reopen"].includes(subaction)
			) {
				const match = output.match(/\/issues\/(\d+)/);
				if (match) {
					return { url: output, number: Number(match[1]) };
				}
			}

			// Invalidate cache on mutations
			if (
				subcommand === "label" &&
				LABEL_MUTATION_ACTIONS.includes(subaction as LabelMutationAction)
			) {
				delete cache.labels;
			} else if (
				subcommand === "api" &&
				args.some((a) => a.includes("milestones"))
			) {
				delete cache.milestones;
			}

			return { output };
		},
	});

	const respondTool = tool({
		description:
			"Chame esta ferramenta ao terminar para reportar o resultado da ação. Sempre chame ao final.",
		inputSchema: z.object({
			type: z.enum(["action", "list", "refused"]),
			title: z.string().optional().describe("Título da ação ou da listagem"),
			body: z
				.string()
				.optional()
				.describe(
					"Corpo em Markdown: descrição da issue criada, resumo relevante, ou lista formatada",
				),
			url: z
				.string()
				.optional()
				.describe("URL da issue ou comentário (quando disponível)"),
			reason: z.string().optional().describe("Motivo da recusa (para refused)"),
		}),
	});

	const agent = new ToolLoopAgent({
		model,
		instructions: systemPrompt,
		tools: { gh: ghTool, respond: respondTool },
		stopWhen: [hasToolCall("respond"), stepCountIs(20)],
		onStepFinish(step) {
			console.log(`[ai] step ${step.stepNumber}`);
			if (step.reasoningText)
				console.log(`[ai] reasoning: ${step.reasoningText}`);
			if (step.text) console.log(`[ai] text: ${step.text}`);
			for (const call of step.toolCalls) {
				console.log(`[ai] tool call: ${call.toolName}`, call.input);
			}
		},
	});

	const generation = await agent.generate({ prompt: content + imageContext });

	const respondCall = generation.staticToolCalls.find(
		(c) => c.toolName === "respond",
	);

	if (!respondCall) {
		return {
			type: "refused",
			reason:
				"Não consigo processar essa solicitação. Por favor, forneça mais detalhes.",
		};
	}

	const input = respondCall.input;

	switch (input.type) {
		case "action":
			return {
				type: "action",
				title: input.title ?? "",
				body: input.body,
				url: input.url,
			};
		case "list":
			return {
				type: "list",
				title: input.title ?? "",
				body: input.body ?? "",
			};
		case "refused":
			return {
				type: "refused",
				reason: input.reason ?? "Não consigo processar essa solicitação.",
			};
	}
}
