import { useParams } from "react-router-dom";

export default function ChatPage() {
  const { channelId } = useParams();
  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold">Chat</h1>
      <p className="text-muted-foreground">
        {channelId ? `Channel: ${channelId}` : "Select a channel..."}
      </p>
    </div>
  );
}
