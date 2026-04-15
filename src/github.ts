import axios from "axios";

type GraphQLVariables = Record<string, unknown>;

type GraphQLExecutor = (
	query: string,
	variables: GraphQLVariables,
) => Promise<unknown>;

interface IssueNodeResponse {
	repository?: {
		issue?: {
			id?: string;
		};
	};
}

interface AddSubIssueResponse {
	addSubIssue?: {
		issue?: {
			number: number;
		};
		subIssue?: {
			number: number;
		};
	};
}

interface RemoveSubIssueResponse {
	removeSubIssue?: {
		issue?: {
			number: number;
		};
		subIssue?: {
			number: number;
		};
	};
}

interface ListSubIssuesResponse {
	repository?: {
		issue?: {
			number: number;
			title: string;
			state: string;
			subIssues?: {
				nodes?: Array<{
					number: number;
					title: string;
					state: string;
					url: string;
					assignees?: {
						nodes?: Array<{
							login: string;
						}>;
					};
				}>;
			};
		};
	};
}

export interface RelatedIssue {
	number: number;
	title: string;
	state: string;
	url: string;
	assignees: string[];
}

export interface SubIssueList {
	parent: {
		number: number;
		title: string;
		state: string;
	};
	subIssues: RelatedIssue[];
}

function splitRepo(repo: string): { owner: string; name: string } {
	const [owner, name] = repo.split("/");

	if (!owner || !name) {
		throw new Error(`Invalid repository: ${repo}`);
	}

	return { owner, name };
}

async function getIssueNodeId(
	executeGraphQL: GraphQLExecutor,
	repo: string,
	number: number,
): Promise<string> {
	const { owner, name } = splitRepo(repo);
	const response = (await executeGraphQL(
		`
			query IssueNodeId($owner: String!, $repo: String!, $number: Int!) {
				repository(owner: $owner, name: $repo) {
					issue(number: $number) {
						id
					}
				}
			}
		`,
		{ owner, repo: name, number },
	)) as IssueNodeResponse;

	const issueId = response.repository?.issue?.id;

	if (!issueId) {
		throw new Error(`Issue #${number} not found in ${repo}`);
	}

	return issueId;
}

export function createIssueHierarchyClient(executeGraphQL: GraphQLExecutor) {
	return {
		async addSubIssue(repo: string, parentNumber: number, childNumber: number) {
			const [parentId, childId] = await Promise.all([
				getIssueNodeId(executeGraphQL, repo, parentNumber),
				getIssueNodeId(executeGraphQL, repo, childNumber),
			]);
			const response = (await executeGraphQL(
				`
					mutation AddSubIssue($parentId: ID!, $subIssueId: ID!) {
						addSubIssue(input: { issueId: $parentId, subIssueId: $subIssueId }) {
							issue {
								number
							}
							subIssue {
								number
							}
						}
					}
				`,
				{ parentId, subIssueId: childId },
			)) as AddSubIssueResponse;

			const result = response.addSubIssue;

			if (!result?.issue?.number || !result.subIssue?.number) {
				throw new Error("GitHub did not return the linked issues");
			}

			return {
				parentNumber: result.issue.number,
				childNumber: result.subIssue.number,
			};
		},

		async removeSubIssue(
			repo: string,
			parentNumber: number,
			childNumber: number,
		) {
			const [parentId, childId] = await Promise.all([
				getIssueNodeId(executeGraphQL, repo, parentNumber),
				getIssueNodeId(executeGraphQL, repo, childNumber),
			]);
			const response = (await executeGraphQL(
				`
					mutation RemoveSubIssue($parentId: ID!, $subIssueId: ID!) {
						removeSubIssue(input: { issueId: $parentId, subIssueId: $subIssueId }) {
							issue {
								number
							}
							subIssue {
								number
							}
						}
					}
				`,
				{ parentId, subIssueId: childId },
			)) as RemoveSubIssueResponse;

			const result = response.removeSubIssue;

			if (!result?.issue?.number || !result.subIssue?.number) {
				throw new Error("GitHub did not return the unlinked issues");
			}

			return {
				parentNumber: result.issue.number,
				childNumber: result.subIssue.number,
			};
		},

		async listSubIssues(
			repo: string,
			parentNumber: number,
		): Promise<SubIssueList> {
			const { owner, name } = splitRepo(repo);
			const response = (await executeGraphQL(
				`
					query ListSubIssues($owner: String!, $repo: String!, $number: Int!, $limit: Int!) {
						repository(owner: $owner, name: $repo) {
							issue(number: $number) {
								number
								title
								state
								subIssues(first: $limit) {
									nodes {
										number
										title
										state
										url
										assignees(first: 10) {
											nodes {
												login
											}
										}
									}
								}
							}
						}
					}
				`,
				{ owner, repo: name, number: parentNumber, limit: 30 },
			)) as ListSubIssuesResponse;

			const issue = response.repository?.issue;

			if (!issue) {
				throw new Error(`Issue #${parentNumber} not found in ${repo}`);
			}

			return {
				parent: {
					number: issue.number,
					title: issue.title,
					state: issue.state.toLowerCase(),
				},
				subIssues: (issue.subIssues?.nodes ?? []).map((subIssue) => ({
					number: subIssue.number,
					title: subIssue.title,
					state: subIssue.state.toLowerCase(),
					url: subIssue.url,
					assignees: (subIssue.assignees?.nodes ?? []).map(
						(assignee) => assignee.login,
					),
				})),
			};
		},
	};
}

export type IssueHierarchyClient = ReturnType<
	typeof createIssueHierarchyClient
>;

export function createGitHubClient(token: string) {
	const client = axios.create({
		baseURL: "https://api.github.com",
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
		},
	});

	const executeGraphQL: GraphQLExecutor = async (query, variables) => {
		const { data } = await client.post<{
			data?: unknown;
			errors?: { message: string }[];
		}>("/graphql", { query, variables });

		if (data.errors?.length) {
			throw new Error(data.errors.map((error) => error.message).join("; "));
		}

		return data.data;
	};

	async function fetchCollaborators(repo: string): Promise<string[]> {
		try {
			const { owner, name } = splitRepo(repo);
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
			const { owner, name } = splitRepo(repo);
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
			const { owner, name } = splitRepo(repo);
			const { data } = await client.get<{ title: string }[]>(
				`/repos/${owner}/${name}/milestones`,
				{ params: { per_page: 100 } },
			);
			return data.map((m) => m.title);
		} catch {
			return [];
		}
	}

	return {
		fetchCollaborators,
		fetchLabels,
		fetchMilestones,
		...createIssueHierarchyClient(executeGraphQL),
	};
}
