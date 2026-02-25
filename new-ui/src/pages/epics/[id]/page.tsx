import { useParams } from "react-router-dom";

export default function EpicDetailPage() {
  const { id } = useParams();
  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold">Epic Detail</h1>
      <p className="text-muted-foreground">Epic: {id}</p>
    </div>
  );
}
