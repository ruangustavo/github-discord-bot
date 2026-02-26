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

const [owner, repo] = env.GITHUB_REPO.split("/");

function appendImages(body: string, imageUrls?: string[]): string {
	return imageUrls?.length
		? `${body}\n\n${imageUrls.map((u) => `![image](${u})`).join("\n")}`
		: body;
}

export async function getIssue(
	issueNumber: number,
): Promise<{ title: string; url: string } | null> {
	try {
		const response = await api.get(
			`/repos/${owner}/${repo}/issues/${issueNumber}`,
		);
		return { title: response.data.title, url: response.data.html_url };
	} catch (error) {
		if (axios.isAxiosError(error) && error.response?.status === 404) {
			return null;
		}
		throw error;
	}
}

export async function createIssue(
	title: string,
	body: string,
	imageUrls?: string[],
): Promise<{ url: string; number: number }> {
	const response = await api.post(`/repos/${owner}/${repo}/issues`, {
		title,
		body: appendImages(body, imageUrls),
	});
	return { url: response.data.html_url, number: response.data.number };
}

export async function addComment(
	issueNumber: number,
	body: string,
	imageUrls?: string[],
): Promise<{ url: string }> {
	const response = await api.post(
		`/repos/${owner}/${repo}/issues/${issueNumber}/comments`,
		{ body: appendImages(body, imageUrls) },
	);
	return { url: response.data.html_url };
}
