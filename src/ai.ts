import { openai } from "@ai-sdk/openai";
import { hasToolCall, ToolLoopAgent, tool } from "ai";
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

Ações suportadas:
- Criar issue: gh issue create --title "..." --body "..." --json number,url (ação PADRÃO)
- Comentar em issue: primeiro gh issue view NÚMERO --json title,url, depois gh issue comment NÚMERO --body "..."
- Fechar/reabrir issue: primeiro gh issue view NÚMERO --json title,url, depois gh issue close/reopen NÚMERO
- Editar issue (título, corpo): primeiro gh issue view NÚMERO --json title,url, depois gh issue edit NÚMERO --title "..." --body "..."
- Atribuir colaborador: primeiro gh issue view NÚMERO --json title,url, depois gh issue edit NÚMERO --add-assignee USUÁRIO
- Adicionar/remover label: primeiro gh issue view NÚMERO --json title,url, depois gh issue edit NÚMERO --add-label NOME / --remove-label NOME
- Definir milestone: primeiro gh issue view NÚMERO --json title,url, depois gh issue edit NÚMERO --milestone NOME
- Listar issues: gh issue list
- Criar label: gh label create NOME --color "#hex" --repo REPO
- Gerenciar milestones: gh api repos/:owner/:repo/milestones (GET para listar, POST -f title="..." para criar)

Regras:
- Criar issue é a ação PADRÃO para qualquer conteúdo acionável (bug, funcionalidade, problema, dúvida).
- Use os colaboradores, labels e milestones do contexto acima ao interpretar referências por nome.
- Ao criar uma issue: gere título conciso e descrição sucinta em Markdown, ambos em português. Reorganize as ideias sem expandir escopo.
- Para ações em issues existentes: sempre busque title e url antes de chamar respond.
- Recuse APENAS se o conteúdo for completamente fora do escopo de gerenciamento de issues.
- Se houver URLs de imagens na mensagem, inclua-as no corpo como markdown: ![image](URL)`;
}

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
	| {
			type: "issue_updated";
			issueTitle: string;
			url: string;
			issueNumber: number;
			summary: string;
	  }
	| { type: "refused"; reason: string };

const ALLOWED_SUBCOMMANDS = ["issue", "label", "api"] as const;
type AllowedSubcommand = (typeof ALLOWED_SUBCOMMANDS)[number];

const LABEL_MUTATION_ACTIONS = ["create", "delete", "edit"] as const;
type LabelMutationAction = (typeof LABEL_MUTATION_ACTIONS)[number];

export async function processRequest(
	content: string,
	imageUrls: string[] = [],
): Promise<RequestResult> {
	let result: RequestResult | null = null;

	const [collaborators, labels, milestones] = await Promise.all([
		getCollaborators(),
		getLabels(),
		getMilestones(),
	]);

	const systemPrompt = buildSystemPrompt({ collaborators, labels, milestones });

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
  ["issue", "create", "--title", "Bug: login quebrado", "--body", "Passos...", "--json", "number,url"]
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

			return { output: stdout.trim() };
		},
	});

	const respondTool = tool({
		description:
			"Chame esta ferramenta ao terminar para reportar o resultado da ação. Sempre chame ao final.",
		inputSchema: z.object({
			action: z.enum([
				"issue_created",
				"comment_added",
				"issue_updated",
				"refused",
			]),
			title: z
				.string()
				.optional()
				.describe("Título da issue (para issue_created)"),
			description: z
				.string()
				.optional()
				.describe("Corpo da issue (para issue_created)"),
			issueTitle: z
				.string()
				.optional()
				.describe("Título da issue (para comment_added e issue_updated)"),
			url: z.string().optional().describe("URL da issue ou comentário criado"),
			number: z
				.number()
				.optional()
				.describe("Número da issue (para issue_created)"),
			issueNumber: z
				.number()
				.optional()
				.describe("Número da issue (para comment_added e issue_updated)"),
			summary: z
				.string()
				.optional()
				.describe(
					'Resumo curto da ação realizada (para issue_updated), ex: "Issue fechada", "Label \'bug\' adicionada", "Atribuído a ruangustavo"',
				),
			reason: z.string().optional().describe("Motivo da recusa (para refused)"),
		}),
		execute: async (input) => {
			switch (input.action) {
				case "issue_created":
					result = {
						type: "issue_created",
						title: input.title ?? "",
						description: input.description ?? "",
						url: input.url ?? "",
						number: input.number ?? 0,
					};
					break;
				case "comment_added":
					result = {
						type: "comment_added",
						issueTitle: input.issueTitle ?? "",
						url: input.url ?? "",
						issueNumber: input.issueNumber ?? 0,
					};
					break;
				case "issue_updated":
					result = {
						type: "issue_updated",
						issueTitle: input.issueTitle ?? "",
						url: input.url ?? "",
						issueNumber: input.issueNumber ?? 0,
						summary: input.summary ?? "",
					};
					break;
				case "refused":
					result = {
						type: "refused",
						reason: input.reason ?? "Não consigo processar essa solicitação.",
					};
					break;
			}
			return { ok: true };
		},
	});

	const agent = new ToolLoopAgent({
		model,
		instructions: systemPrompt,
		tools: { gh: ghTool, respond: respondTool },
		stopWhen: hasToolCall("respond"),
	});

	await agent.generate({ prompt: content + imageContext });

	return (
		result ?? {
			type: "refused",
			reason:
				"Não consigo processar essa solicitação. Por favor, forneça mais detalhes.",
		}
	);
}
