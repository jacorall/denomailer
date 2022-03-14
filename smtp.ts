import { CommandCode } from "./code.ts";
import type {
  ConnectConfig,
  ConnectConfigWithAuthentication,
  SendConfig,
} from "./config.ts";
import {
  normaliceMailList,
  normaliceMailString,
  validateConfig,
} from "./config.ts";
import { BufReader, BufWriter, TextProtoReader } from "./deps.ts";
import { base64Decode, quotedPrintableEncode } from "./encoding.ts";

const encoder = new TextEncoder();

interface Command {
  code: number;
  args: string;
}

interface SmtpClientOptions {
  console_debug?: boolean;
  unsecure?: boolean;
}

export class SmtpClient {
  #secure = false;

  #conn: Deno.Conn | null = null;
  #reader: TextProtoReader | null = null;
  #writer: BufWriter | null = null;

  #console_debug = false;
  #allowUnsecure = false;

  constructor({
    console_debug = false,
    unsecure = false,
  }: SmtpClientOptions = {}) {
    this.#console_debug = console_debug;
    this.#allowUnsecure = unsecure;
  }

  async connect(config: ConnectConfig | ConnectConfigWithAuthentication) {
    const conn = await Deno.connect({
      hostname: config.hostname,
      port: config.port || 25,
    });
    await this.#connect(conn, config);
  }

  async connectTLS(config: ConnectConfig | ConnectConfigWithAuthentication) {
    const conn = await Deno.connectTls({
      hostname: config.hostname,
      port: config.port || 465,
    });
    this.#secure = true;
    await this.#connect(conn, config);
  }

  async close() {
    if (!this.#conn) {
      return;
    }
    await this.#conn.close();
  }

  #currentlySending = false;
  #sending: (() => void)[] = [];

  #cueSending() {
    if (!this.#currentlySending) {
      this.#currentlySending = true;
      return;
    }

    return new Promise<void>((res) => {
      this.#sending.push(() => {
        this.#currentlySending = true;
        res();
      });
    });
  }

  #queNextSending() {
    if (this.#sending.length === 0) {
      this.#currentlySending = false;
      return;
    }

    const run = this.#sending[0];

    this.#sending.splice(0, 1);

    queueMicrotask(run);
  }

  async send(config: SendConfig) {
    try {
      await this.#cueSending();

      validateConfig(config);

      const [from, fromData] = this.parseAddress(config.from);

      const to = normaliceMailList(config.to).map((m) => this.parseAddress(m));

      const date = config.date ??
        new Date().toUTCString().split(",")[1].slice(1);

      if (config.mimeContent && (config.html || config.content)) {
        throw new Error(
          "You should not use mimeContent together with html or content option!",
        );
      }

      if (!config.mimeContent) {
        config.mimeContent = [];

        // Allows to auto
        if (config.content === "auto" && config.html) {
          config.content = config.html
            .replace(/<head((.|\n|\r)*?)<\/head>/g, "")
            .replace(/<style((.|\n|\r)*?)<\/style>/g, "")
            .replace(/<[^>]+>/g, "");
        }

        if (config.content) {
          config.mimeContent.push({
            mimeType: 'text/plain; charset="utf-8"',
            content: quotedPrintableEncode(config.content),
            transferEncoding: "quoted-printable",
          });
        }

        if (config.html) {
          if (!config.content) {
            console.warn(
              "[SMTP] We highly recomand adding a plain text content in addition to your html content! You can set content to 'auto' to do this automaticly!",
            );
          }

          config.mimeContent.push({
            mimeType: 'text/html; charset="utf-8"',
            content: quotedPrintableEncode(config.html),
            transferEncoding: "quoted-printable",
          });
        }
      }

      if (config.mimeContent.length === 0) {
        throw new Error("No Content provided!");
      }

      if(config.mimeContent.some(v=>v.mimeType.includes('--message') || v.transferEncoding?.includes('--message'))) {throw new Error("--message is not allowed to appear in mimetype or transferEncoding")}

      if(config.attachments) {
        for (let i = 0; i < config.attachments.length; i++) {
          const att = config.attachments[i];
          if(att.encoding === 'text') {
            att.content = quotedPrintableEncode(att.content)
          } else if (att.encoding === 'base64') {
            config.attachments[i] = {
              encoding: 'binary',
              contentType: att.contentType,
              content: base64Decode(att.content),
              filename: att.filename  
            }
          }

          const thr1 = att.filename.includes('--attachment') || att.contentType.includes('--attachment')

          if(thr1) throw new Error('attachment contentype and filename are not allowed to contain --attachment.')
        }
      }

      await this.writeCmd("MAIL", "FROM:", from);
      this.assertCode(await this.readCmd(), CommandCode.OK);

      for (let i = 0; i < to.length; i++) {
        await this.writeCmd("RCPT", "TO:", to[i][0]);
        this.assertCode(await this.readCmd(), CommandCode.OK);
      }

      const cc = config.cc
        ? normaliceMailList(config.cc).map((v) => this.parseAddress(v))
        : false;

      if (cc) {
        console.log("cc");
        for (let i = 0; i < cc.length; i++) {
          await this.writeCmd("RCPT", "TO:", cc[i][0]);
          this.assertCode(await this.readCmd(), CommandCode.OK);
        }
      }

      if (config.bcc) {
        const bcc = normaliceMailList(config.bcc).map((v) =>
          this.parseAddress(v)
        );

        for (let i = 0; i < bcc.length; i++) {
          await this.writeCmd("RCPT", "TO:", bcc[i][0]);
          this.assertCode(await this.readCmd(), CommandCode.OK);
        }
      }

      await this.writeCmd("DATA");
      this.assertCode(await this.readCmd(), CommandCode.BEGIN_DATA);

      await this.writeCmd("Subject: ", config.subject);
      await this.writeCmd("From: ", fromData);
      await this.writeCmd("To: ", to.map((v) => v[1]).join(";"));
      if (cc) {
        await this.writeCmd("Cc: ", cc.map((v) => v[1]).join(";"));
      }
      await this.writeCmd("Date: ", date);

      if (config.inReplyTo) {
        await this.writeCmd("InReplyTo: ", config.inReplyTo);
      }

      if (config.references) {
        await this.writeCmd("Refrences: ", config.references);
      }

      if (config.replyTo) {
        config.replyTo = normaliceMailString(config.replyTo);

        await this.writeCmd("ReplyTo: ", config.replyTo);
      }

      if (config.priority) {
        await this.writeCmd("Priority:", config.priority);
      }

      // Calc attachment boundary
      let attBoundary = 'attachment-0563167'

      while (true) {
        let nonBreak1 = config.mimeContent.some(v => v.content.includes(`--${attBoundary}`)) || (config.attachments && config.attachments.some(v => v.encoding === 'text' ? v.content.includes(`--${attBoundary}`) : false))
        
        if(!nonBreak1 && config.attachments) {
          nonBreak1 = config.attachments.some(el => {
            if(el.encoding === 'binary') {
              const arr = new Uint8Array(el.content)
              const text = encoder.encode(attBoundary)

              for (let i = 0; i < arr.length - text.length + 1; i++) {
                let found = true
                for (let j = 0; j < text.length; j++) {
                  if(arr[i+j] !== text[j]) {
                    found = false
                    i++
                    j = 0
                  }
                }

                if(found) {
                  return true
                }
              }

            }
          })
        }

        if(!nonBreak1) break


        attBoundary = 'attachment-' + Math.random().toString()
      }


      await this.writeCmd("MIME-Version: 1.0");

      await this.writeCmd(
        `Content-Type: multipart/mixed; boundary=${attBoundary}`,
        "\r\n",
      );
      await this.writeCmd(`--${attBoundary}`);

      // Calc good msg boundary:
      let msgBoundary = 'message-54343521687'

      while(config.mimeContent.some(v => v.content.includes(`--${msgBoundary}`))) {
        msgBoundary = 'message-' + Math.random().toString()
      }


      await this.writeCmd(
        `Content-Type: multipart/alternative; boundary=${msgBoundary}`,
        "\r\n",
      );

      for (let i = 0; i < config.mimeContent.length; i++) {
        await this.writeCmd(`--${msgBoundary}`);
        await this.writeCmd(
          "Content-Type: " + config.mimeContent[i].mimeType,
        );
        if (config.mimeContent[i].transferEncoding) {
          await this.writeCmd(
            `Content-Transfer-Encoding: ${
              config.mimeContent[i].transferEncoding
            }` + "\r\n",
          );
        } else {
          // Send new line
          await this.writeCmd("");
        }

        await this.writeCmd(config.mimeContent[i].content, "\r\n");
      }

      await this.writeCmd(`--${msgBoundary}--\r\n`);

      if (config.attachments) {
        // Setup attachments
        for (let i = 0; i < config.attachments.length; i++) {
          const attachment = config.attachments[i];

          await this.writeCmd(`--${attBoundary}`);
          await this.writeCmd(
            "Content-Type:",
            attachment.contentType + ";",
            "name=" + attachment.filename,
          );

          await this.writeCmd(
            "Content-Disposition: attachment; filename=" + attachment.filename,
            "\r\n",
          );

          if (attachment.encoding === "binary") {
            await this.writeCmd("Content-Transfer-Encoding: binary");

            if (
              attachment.content instanceof ArrayBuffer ||
              attachment.content instanceof SharedArrayBuffer
            ) {
              await this.writeCmdBinary(new Uint8Array(attachment.content));
            } else {
              await this.writeCmdBinary(attachment.content);
            }

            await this.writeCmd("\r\n");
          } else if (attachment.encoding === "text") {
            await this.writeCmd("Content-Transfer-Encoding: quoted-printable");

            await this.writeCmd(attachment.content, "\r\n");
          }
        }
      }

      await this.writeCmd(`--${attBoundary}--\r\n`);

      await this.writeCmd(".\r\n");

      this.assertCode(await this.readCmd(), CommandCode.OK);
    } catch (ex) {
      this.#queNextSending();
      throw ex;
    }

    this.#queNextSending();
  }

  async #connect(conn: Deno.Conn, config: ConnectConfig) {
    this.#conn = conn;
    const reader = new BufReader(this.#conn);
    this.#writer = new BufWriter(this.#conn);
    this.#reader = new TextProtoReader(reader);

    this.assertCode(await this.readCmd(), CommandCode.READY);

    await this.writeCmd("EHLO", config.hostname);

    let startTLS = false;

    while (true) {
      const cmd = await this.readCmd();
      if (!cmd || !cmd.args.startsWith("-")) break;
      if (cmd.args == "-STARTTLS") startTLS = true;
    }

    if (startTLS) {
      await this.writeCmd("STARTTLS");
      this.assertCode(await this.readCmd(), CommandCode.READY);

      this.#conn = await Deno.startTls(this.#conn, {
        hostname: config.hostname,
      });

      this.#secure = true;

      const reader = new BufReader(this.#conn);
      this.#writer = new BufWriter(this.#conn);
      this.#reader = new TextProtoReader(reader);

      await this.writeCmd("EHLO", config.hostname);

      while (true) {
        const cmd = await this.readCmd();
        if (!cmd || !cmd.args.startsWith("-")) break;
      }
    }

    if (!this.#allowUnsecure && !this.#secure) {
      throw new Error(
        "Connection is not secure! Don't send authentication over non secure connection!",
      );
    }

    if (this.useAuthentication(config)) {
      await this.writeCmd("AUTH", "LOGIN");
      this.assertCode(await this.readCmd(), 334);

      await this.writeCmd(btoa(config.username));
      this.assertCode(await this.readCmd(), 334);

      await this.writeCmd(btoa(config.password));
      this.assertCode(await this.readCmd(), CommandCode.AUTHO_SUCCESS);
    }
  }

  private assertCode(cmd: Command | null, code: number, msg?: string) {
    if (!cmd) {
      throw new Error(`invalid cmd`);
    }
    if (cmd.code !== code) {
      throw new Error(msg || cmd.code + ": " + cmd.args);
    }
  }

  private async readCmd(): Promise<Command | null> {
    if (!this.#reader) {
      return null;
    }
    const result = await this.#reader.readLine();
    if (result === null) return null;
    const cmdCode = parseInt(result.slice(0, 3).trim());
    const cmdArgs = result.slice(3).trim();
    return {
      code: cmdCode,
      args: cmdArgs,
    };
  }

  private async writeCmd(...args: string[]) {
    if (!this.#writer) {
      return null;
    }

    if (this.#console_debug) {
      console.table(args);
    }

    const data = encoder.encode([...args].join(" ") + "\r\n");
    await this.#writer.write(data);
    await this.#writer.flush();
  }

  private async writeCmdBinary(...args: Uint8Array[]) {
    if (!this.#writer) {
      return null;
    }

    if (this.#console_debug) {
      console.table(args.map(() => "Uint8Attay"));
    }

    for (let i = 0; i < args.length; i++) {
      await this.#writer.write(args[i]);
    }
    await this.#writer.flush();
  }

  private useAuthentication(
    config: ConnectConfig | ConnectConfigWithAuthentication,
  ): config is ConnectConfigWithAuthentication {
    return (config as ConnectConfigWithAuthentication).username !== undefined;
  }

  private parseAddress(
    email: string,
  ): [string, string] {
    if (email.includes("<")) {
      const m = email.split("<")[1].split(">")[0];
      return [`<${m}>`, email];
    } else {
      return [`<${email}>`, `<${email}>`];
    }
  }
}
