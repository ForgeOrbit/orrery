import { Link } from "@tanstack/react-router";
import { ApiProblemError } from "../../lib/api.ts";

// The one failure page for a project, issue, or knowledge entry. A 401 asks the reader to
// sign in; a 404 keeps the resource's existence private; anything else is a load failure.
type Resource = "project" | "issue" | "knowledge" | "workspace" | "history";

const labels: Record<Resource, { title: string; noun: string }> = {
  project: { title: "Project", noun: "project" },
  issue: { title: "Issue", noun: "issue" },
  knowledge: { title: "Knowledge", noun: "knowledge entry" },
  workspace: { title: "Workspace", noun: "workspace" },
  history: { title: "History", noun: "history" },
};

export function ResourceLoadError({ resource, error }: { resource: Resource; error: unknown }) {
  const { title, noun } = labels[resource];

  if (error instanceof ApiProblemError && error.status === 401) {
    return (
      <main>
        <h1>{title}</h1>
        <p role="alert">Sign in to view this {noun}.</p>
        <p>
          <Link to="/signin">Sign in</Link>
        </p>
      </main>
    );
  }

  if (error instanceof ApiProblemError && error.status === 404) {
    return (
      <main>
        <h1>{title}</h1>
        <p role="alert">This {noun} does not exist or is not available to you.</p>
        <p>
          <Link to="/">Go to your workspaces</Link>
        </p>
      </main>
    );
  }

  if (error instanceof ApiProblemError && error.status === 403) {
    return (
      <main>
        <h1>{title}</h1>
        <p role="alert">You do not have permission to view this {noun}.</p>
        <p>
          <Link to="/">Go to your workspaces</Link>
        </p>
      </main>
    );
  }

  return (
    <main>
      <h1>{title}</h1>
      <p role="alert">Could not load this {noun}. Check your connection and try again.</p>
    </main>
  );
}
