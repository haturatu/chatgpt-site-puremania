import PureManiaFrame from "./pure-mania-frame";
import { requireChatGPTUser } from "./chatgpt-auth";

export const dynamic = "force-dynamic";

export default async function Home() {
  if (!import.meta.env.DEV) await requireChatGPTUser("/");
  return <PureManiaFrame />;
}
