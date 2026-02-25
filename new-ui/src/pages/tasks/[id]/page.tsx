import { useParams } from "react-router-dom";

export default function TaskDetailPage() {
  const { id } = useParams();
  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold">Task Detail</h1>
      <p className="text-muted-foreground">Task: {id}</p>
    </div>
  );
}
