import axios from "axios";
import { env } from "./env.ts";

const api = axios.create({
	baseURL: "https://api.github.com",
	headers: {
		Authorization: `Bearer ${env.GITHUB_TOKEN}`,
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28",
	},
});

export async function createIssue(
	title: string,
	body: string,
): Promise<string> {
	const [owner, repo] = env.GITHUB_REPO.split("/");
	const response = await api.post(`/repos/${owner}/${repo}/issues`, {
		title,
		body,
	});
	return response.data.html_url;
}
