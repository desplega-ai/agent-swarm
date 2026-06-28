// @swarm/integrations/gitlab subpath — physical re-export file.
// GitLab's handlers + types (handleIssue/IssueEvent/MergeRequestEvent/...) share
// names with GitHub's, so they are NAMESPACED in the main barrel. Consumers that
// need GitLab's specific symbols import them from "@swarm/integrations/gitlab".
// A physical file (rather than a package.json "exports" entry) is used so the
// package can keep deep "@swarm/integrations/src/..." subpath imports working.
export * from "./src/gitlab/index";
