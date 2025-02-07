import { SmtpClient } from "./smtp.ts";
import "https://deno.land/std@0.130.0/dotenv/load.ts";

const { TLS, PORT, HOSTNAME, MAIL_USER, MAIL_TO_USER, MAIL_PASS } = Deno.env
  .toObject();

const client = new SmtpClient();
const config = {
  hostname: HOSTNAME,
  port: PORT ? parseInt(PORT) : undefined,
  username: MAIL_USER,
  password: MAIL_PASS,
};
if (TLS) {
  await client.connectTLS(config);
} else {
  await client.connect(config);
}

await client.send({
  from: MAIL_USER,
  to: MAIL_TO_USER,
  subject: "Deno Smtp build Success" + Math.random() * 1000,
  content: "plain text email",
  html: `
  <!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="UTF-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <meta http-equiv="X-UA-Compatible" content="ie=edge" />
          <title>Deno Smtp build Success</title>
        </head>
        <body>
          <h1>Success</h1>
          <p>Build succeed!</p>
          <p>${new Date()}</p>
        </body>
      </html>
  `,
});

await client.close();
