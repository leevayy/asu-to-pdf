import { Telegraf } from "telegraf";
import { parseBookUrl } from "./url_parser.ts";
import { message } from "telegraf/filters";
import PDFDocument from "pdfkit";
import { Buffer } from "node:buffer";
import { compress } from "compress-pdf";

interface DownloadOptions {
  maxRetries?: number;
  retryDelay?: number;
  outputPath?: string;
  bookId?: string;
  bookName?: string;
  onProgress?: (page: number) => void;
  timeout?: number;
}

async function downloadImage(
  page: number,
  options: DownloadOptions,
): Promise<Uint8Array | false> {
  const {
    bookId,
    bookName,
    maxRetries = 3,
    retryDelay = 500,
    timeout = 30000,
  } = options;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      const response = await fetch(
        `http://elibrary.asu.ru/els/files/test/?name=${bookName}&id=${bookId}&page=${page}&mode=1`,
        {
          headers: {
            "Accept":
              "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
            "Accept-Language": "en,ru;q=0.9",
            "Connection": "keep-alive",
            "DNT": "1",
            "Referer":
              `http://elibrary.asu.ru/els/files/book?id=${bookId}&name=${bookName}`,
            "User-Agent":
              "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
          },
          signal: controller.signal,
        },
      );

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const buffer = await response.arrayBuffer();
      if (buffer.byteLength === 0) {
        console.log(
          `Received empty response for page ${page}, assuming end of book`,
        );
        return false;
      }

      console.log(`Successfully downloaded page ${page}`);
      // Add a delay between downloads to prevent rate limiting
      await new Promise((resolve) => setTimeout(resolve, 500));
      return new Uint8Array(buffer);
    } catch (error: unknown) {
      if (error instanceof Error) {
        console.error(
          `Error downloading page ${page} (attempt ${
            attempt + 1
          }/${maxRetries}):`,
          error,
        );
      } else {
        console.error(
          `Error downloading page ${page} (attempt ${
            attempt + 1
          }/${maxRetries}): Unknown error`,
        );
      }
      if (attempt < maxRetries - 1) {
        await new Promise((resolve) => setTimeout(resolve, retryDelay));
      } else {
        throw error;
      }
    }
  }
  return false;
}

function isValidImage(buffer: Uint8Array): boolean {
  // Check for minimum size
  if (buffer.length < 4) {
    console.log("Buffer too small to be a valid image");
    return false;
  }

  // Check for PNG signature (89 50 4E 47)
  const isPNG = buffer[0] === 0x89 && buffer[1] === 0x50 &&
    buffer[2] === 0x4E && buffer[3] === 0x47;
  if (isPNG) {
    console.log("Valid PNG image detected");
    return true;
  }

  // Check for JPEG signature (FF D8)
  const isJPEG = buffer[0] === 0xFF && buffer[1] === 0xD8;
  if (isJPEG) {
    console.log("Valid JPEG image detected");
    return true;
  }

  console.log("Invalid image format - neither PNG nor JPEG");
  return false;
}

async function downloadBookToBuffer(
  options: DownloadOptions = {},
) {
  const images: Uint8Array[] = [];
  const invalidPages: number[] = [];

  let page = 1;
  let consecutiveEmptyResponses = 0;
  const MAX_EMPTY_RESPONSES = 3;
  const { onProgress } = options;

  while (consecutiveEmptyResponses < MAX_EMPTY_RESPONSES) {
    try {
      const imageBuffer = await downloadImage(page, options);
      if (!imageBuffer) {
        consecutiveEmptyResponses++;
      } else {
        if (isValidImage(imageBuffer)) {
          images.push(imageBuffer);
          consecutiveEmptyResponses = 0;
          onProgress?.(page);
          page++;
        } else {
          console.error(
            `Invalid image data received for page ${page}, skipping...`,
          );
          invalidPages.push(page);
          page++;
        }
      }
    } catch (error: unknown) {
      if (error instanceof Error) {
        console.error(
          `Failed to download page ${page} after all retries:`,
          error,
        );
      } else {
        console.error(
          `Failed to download page ${page} after all retries: Unknown error`,
        );
      }
      break;
    }
  }

  console.log(`Creating PDF with ${images.length} pages...`);
  const doc = new PDFDocument({ autoFirstPage: false });
  const chunks: Buffer[] = [];

  doc.on("data", (chunk) => chunks.push(chunk));

  for (const imageData of images) {
    doc.addPage();
    doc.image(Buffer.from(imageData), 0, 0, {
      fit: [doc.page.width, doc.page.height],
      align: "center",
      valign: "center",
    });
    console.log("Added page to PDF");
  }

  doc.end();

  return new Promise<Buffer>((resolve) => {
    doc.on("end", () => {
      const pdfBuffer = Buffer.concat(chunks);
      resolve(compress(pdfBuffer, { "imageQuality": 1000 }));
    });
  });
}

if (import.meta.main) {
  const bot = new Telegraf(Deno.env.get("BOT_TOKEN") || "", {
    handlerTimeout: 10 * 60 * 1000,
  });

  bot.command("start", (ctx) => {
    ctx.reply(
      `Привет\\! Этот бот помогает скачивать книги из библиотеки АГУ\\. 

Отправь мне ссылку на книгу и я ее скачаю в формате PDF 😋😋😋
Отправляй *одну ссылку за раз\\!* ⛔️⛔️⛔️

__Примеры ссылок:__

Пример 1:
http://elibrary\\.asu\\.ru/xmlui/handle/asu/9770

Пример 2:
http://elibrary\\.asu\\.ru/xmlui/bitstream/handle/asu/9770/read\\.7book?sequence\\=1&isAllowed\\=y
`,
      { "parse_mode": "MarkdownV2" },
    );
  });

  bot.on(message("text"), async (ctx) => {
    if ("text" in ctx.message) {
      const text = ctx.message.text;
      if (text.includes("elibrary.asu.ru")) {
        try {
          const statusMessage = await ctx.reply("Скачиваю книгу...");

          (async () => {
            try {
              const params = await parseBookUrl(text);
              let lastUpdateTime = Date.now();
              let downloadedPages = 0;

              const emoji = ["😮", "😲", "😳", "😱", "🤯"];

              const updateProgress = async () => {
                const now = Date.now();
                if (now - lastUpdateTime >= 5000) { // Update every 5 seconds
                  const progress = Math.floor(downloadedPages / 25);

                  await ctx.telegram.editMessageText(
                    statusMessage.chat.id,
                    statusMessage.message_id,
                    undefined,
                    `Скачиваю книгу... скачано страниц: ${
                      downloadedPages - 1
                    }. ${emoji[progress > 4 ? 4 : progress]}`,
                  ).catch(console.error); // Ignore update errors
                  lastUpdateTime = now;
                }
              };

              const pdfBuffer = await downloadBookToBuffer({
                ...params,
                retryDelay: 2000, // Increase delay between retries
                onProgress: (page: number) => {
                  downloadedPages = page;
                  updateProgress().catch(console.error);
                },
              });

              await ctx.replyWithDocument({
                source: pdfBuffer,
                filename: `${
                  params.bookActualName || params.bookName || params.bookId ||
                  "book"
                }.pdf`,
              }).catch(async (error) => {
                console.error(error);
                console.error("Error sending document");
                await ctx.reply(
                  "Не удалось отправить ПДФ 😭😭😭 Возможно файл слишком большой...",
                ).catch(console.error);
              });
            } catch (error: unknown) {
              console.error("Download error:", error);
              if (error instanceof Error) {
                await ctx.reply("Не удалось отправить файл 🤔🤔🤔").catch(
                  console.error,
                );
              } else {
                await ctx.reply("Произошел какой-то кринж...").catch(
                  console.error,
                );
              }
            }
          })();
        } catch (error: unknown) {
          if (error instanceof Error) {
            await ctx.reply(`Ошибка 🤫: ${error.message}`);
          } else {
            await ctx.reply("Произошел какой-то неописуемый кринж...");
          }
        }
      }
    }
  });

  bot.launch();
  console.log("Bot started");

  Deno.addSignalListener("SIGINT", () => bot.stop("SIGINT"));
  Deno.addSignalListener("SIGTERM", () => bot.stop("SIGTERM"));
}
