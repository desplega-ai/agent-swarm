import { useParams } from "react-router-dom";

export default function ScheduleDetailPage() {
  const { id } = useParams();
  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold">Schedule Detail</h1>
      <p className="text-muted-foreground">Schedule: {id}</p>
    </div>
  );
}
