import { Health } from "@orrery/contract";
import { useEffect, useState } from "react";

// Placeholder home page: shows that the web app, the server and the shared contract are wired up.
export function App() {
  const [health, setHealth] = useState<Health | "unreachable" | null>(null);

  useEffect(() => {
    fetch("/readyz")
      .then(async (res) => Health.parse(await res.json()))
      .then(setHealth)
      .catch(() => setHealth("unreachable"));
  }, []);

  return (
    <main style={{ fontFamily: "system-ui", padding: "2rem" }}>
      <h1>Orrery</h1>
      <p>
        Server:{" "}
        {health === null
          ? "checking…"
          : health === "unreachable"
            ? "unreachable"
            : `${health.status} (${health.version})`}
      </p>
    </main>
  );
}
