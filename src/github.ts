import axios from "axios";

export function createGitHubClient(token: string) {
	const client = axios.create({
		baseURL: "https://api.github.com",
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
		},
	});

	async function fetchCollaborators(repo: string): Promise<string[]> {
		try {
			const [owner, name] = repo.split("/");
			const { data } = await client.get<{ login: string }[]>(
				`/repos/${owner}/${name}/collaborators`,
				{ params: { per_page: 100 } },
			);
			return data.map((c) => c.login);
		} catch {
			return [];
		}
	}

	async function fetchLabels(repo: string): Promise<string[]> {
		try {
			const [owner, name] = repo.split("/");
			const { data } = await client.get<{ name: string }[]>(
				`/repos/${owner}/${name}/labels`,
				{ params: { per_page: 100 } },
			);
			return data.map((l) => l.name);
		} catch {
			return [];
		}
	}

	async function fetchMilestones(repo: string): Promise<string[]> {
		try {
			const [owner, name] = repo.split("/");
			const { data } = await client.get<{ title: string }[]>(
				`/repos/${owner}/${name}/milestones`,
				{ params: { per_page: 100 } },
			);
			return data.map((m) => m.title);
		} catch {
			return [];
		}
	}

	return { fetchCollaborators, fetchLabels, fetchMilestones };
}
