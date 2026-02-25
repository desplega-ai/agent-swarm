import { useParams } from "react-router-dom";

export default function AgentDetailPage() {
  const { id } = useParams();
  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold">Agent Detail</h1>
      <p className="text-muted-foreground">Agent: {id}</p>
    </div>
  );
}
