export 	const ghTool = tool({
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

    const ghArgs =
      subcommand === "api" ? args : [...args, "--repo", env.GITHUB_REPO];

    let output: string;
    try {
      output = await spawnGh(ghArgs);
    } catch (error) {
      return {
        error:
          error instanceof Error ? error.message : `gh encerrou com erro`,
      };
    }

    if (
      subcommand === "issue" &&
      ["create", "close", "reopen"].includes(subaction)
    ) {
      const match = output.match(ISSUE_URL_PATTERN);
      if (match) {
        return { url: output, number: Number(match[1]) };
      }
    }

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