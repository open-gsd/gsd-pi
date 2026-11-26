#!/usr/bin/env node

const repositoryOwner = process.argv[2];
if (!repositoryOwner) {
	throw new Error("repository owner is required");
}

const chunks = [];
for await (const chunk of process.stdin) {
	chunks.push(chunk);
}

const pullRequests = JSON.parse(chunks.join(""));
const pullRequest = pullRequests.find(
	(candidate) =>
		candidate.isCrossRepository === false &&
		candidate.headRepositoryOwner?.login === repositoryOwner &&
		typeof candidate.url === "string",
);

if (pullRequest) {
	process.stdout.write(pullRequest.url);
}
