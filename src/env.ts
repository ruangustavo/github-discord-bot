import { z } from "zod";

const schema = z.object({
	DISCORD_TOKEN: z.string().min(1),
	GITHUB_TOKEN: z.string().min(1),
	GITHUB_REPO: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
	OPENAI_API_KEY: z.string().min(1),
});

const result = schema.safeParse(process.env);

if (!result.success) {
	console.error(z.treeifyError(result.error));
	process.exit(1);
}

export const env = result.data;
