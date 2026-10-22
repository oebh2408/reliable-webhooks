// A receiving endpoint on plain node:http. With Express, mount nodeHandler on a route
// that has no JSON body parser in front of it: the signature covers the raw bytes.
import { createServer } from "node:http";
import { nodeHandler, WebhookReceiver } from "reliable-webhooks";

const receiver = new WebhookReceiver({
  // During a rotation, list the new and the old secret.
  secrets: [process.env.WEBHOOK_SECRET!],
});

const handle = nodeHandler(receiver, async (event) => {
  // Runs once per message id. Throwing answers 500, and the sender retries.
  switch (event.type) {
    case "order.paid":
      console.log("order paid", event.data);
      break;
    default:
      // Unknown types are acknowledged, so the sender does not retry them.
      break;
  }
});

createServer((req, res) => {
  if (req.method === "POST" && req.url === "/webhooks") return void handle(req, res);
  res.writeHead(404).end();
}).listen(3000);
