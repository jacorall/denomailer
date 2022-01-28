import { CommandCode } from "./code.ts";
import type {
  ConnectConfig,
  ConnectConfigWithAuthentication,
  SendConfig,
} from "./config.ts";
import { BufReader, BufWriter, TextProtoReader } from "./deps.ts";

const encoder = new TextEncoder();

interface Command {
  code: number;
  args: string;
}

enum ContentTransferEncoding {
  "7bit" = "7bit",
  "8bit" = "8bit",
  "base64" = "base64",
  "binary" = "binary",
  "quoted-printable" = "quoted-printable",
}

interface SmtpClientOptions {
  content_encoding?: "7bit" | "8bit" | "base64" | "binary" | "quoted-printable";
  console_debug?: boolean;
}

export class SmtpClient {
  #conn: Deno.Conn | null = null;
  #reader: TextProtoReader | null = null;
  #writer: BufWriter | null = null;

  #console_debug = false;
  #content_encoding: ContentTransferEncoding;

  constructor({
    content_encoding = ContentTransferEncoding["quoted-printable"],
    console_debug = false,
  }: SmtpClientOptions = {}) {
    this.#console_debug = console_debug;

    const _content_encoding = content_encoding.toLowerCase();

    if (!(_content_encoding in ContentTransferEncoding)) {
      throw new Error(
        `${JSON.stringify(content_encoding)} is not a valid content encoding`
      );
    }
    this.#content_encoding = _content_encoding as ContentTransferEncoding;
  }

  async connect(config: ConnectConfig | ConnectConfigWithAuthentication) {
    const conn = await Deno.connect({
      hostname: config.hostname,
      port: config.port || 25,
    });
    await this._connect(conn, config);
  }

  async connectTLS(config: ConnectConfig | ConnectConfigWithAuthentication) {
    const conn = await Deno.connectTls({
      hostname: config.hostname,
      port: config.port || 465,
    });
    await this._connect(conn, config);
  }

  async close() {
    if (!this.#conn) {
      return;
    }
    await this.#conn.close();
  }

  async send(config: SendConfig) {
    const [from, fromData] = this.parseAddress(config.from);
    const [to, toData] = this.parseAddress(config.to);
    const date = config.date ?? new Date().toString();

    await this.writeCmd("MAIL", "FROM:", from);
    this.assertCode(await this.readCmd(), CommandCode.OK);
    await this.writeCmd("RCPT", "TO:", to);
    this.assertCode(await this.readCmd(), CommandCode.OK);
    await this.writeCmd("DATA");
    this.assertCode(await this.readCmd(), CommandCode.BEGIN_DATA);

    await this.writeCmd("Subject: ", config.subject);
    await this.writeCmd("From: ", fromData);
    await this.writeCmd("To: ", toData);
    await this.writeCmd("Date: ", date);

    if (config.html) {
      await this.writeCmd(
        "Content-Type: multipart/alternative; boundary=AlternativeBoundary",
        "\r\n"
      );
      await this.writeCmd("--AlternativeBoundary");
      await this.writeCmd('Content-Type: text/plain; charset="utf-8"', "\r\n");
      await this.writeCmd(config.content, "\r\n");
      await this.writeCmd("--AlternativeBoundary");
      await this.writeCmd('Content-Type: text/html; charset="utf-8"', "\r\n");
      await this.writeCmd(config.html, "\r\n.\r\n");
    } else {
      await this.writeCmd("MIME-Version: 1.0");
      await this.writeCmd("Content-Type: text/plain;charset=utf-8");
      await this.writeCmd(
        `Content-Transfer-Encoding: ${this.#content_encoding}` + "\r\n"
      );
      await this.writeCmd(config.content, "\r\n.\r\n");
    }

    this.assertCode(await this.readCmd(), CommandCode.OK);
  }

  private async _connect(conn: Deno.Conn, config: ConnectConfig) {
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

      const reader = new BufReader(this.#conn);
      this.#writer = new BufWriter(this.#conn);
      this.#reader = new TextProtoReader(reader);

      await this.writeCmd("EHLO", config.hostname);

      while (true) {
        const cmd = await this.readCmd();
        if (!cmd || !cmd.args.startsWith("-")) break;
      }
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

  private useAuthentication(
    config: ConnectConfig | ConnectConfigWithAuthentication
  ): config is ConnectConfigWithAuthentication {
    return (config as ConnectConfigWithAuthentication).username !== undefined;
  }

  private parseAddress(email: string): [string, string] {
    const m = email.toString().match(/(.*)\s<(.*)>/);
    return m?.length === 3
      ? [`<${m[2]}>`, email]
      : [`<${email}>`, `<${email}>`];
  }
}
