import { DOMParser } from "https://deno.land/x/deno_dom@v0.1.43/deno-dom-wasm.ts";

export async function parseBookUrl(
  usersUrl: string,
): Promise<{ bookId: string; bookName: string; bookActualName: string }> {
  try {
    // http://elibrary.asu.ru/xmlui/handle/asu/9770
    // --->
    // http://elibrary.asu.ru/xmlui/bitstream/handle/asu/9770/read.7book?sequence=1&isAllowed=y

    const isLinkToBookPage = usersUrl.includes("elibrary.asu.ru") &&
      usersUrl.includes("xmlui/handle/asu/");

    let linkToBookPage = usersUrl;

    if (!isLinkToBookPage) {
      linkToBookPage = usersUrl.replace(
        "xmlui/bitstream/handle/asu/",
        "xmlui/handle/asu/",
      ).split("/").slice(0, -1).join("/");
    }

    // Fetch the book page to get the actual title
    const bookPageResponse = await fetch(linkToBookPage);
    if (!bookPageResponse.ok) {
      throw new Error(
        `Failed to fetch book page: ${bookPageResponse.status}`,
      );
    }
    const bookPageHtml = await bookPageResponse.text();

    // Create a DOM parser for Deno
    const doc = new DOMParser().parseFromString(bookPageHtml, "text/html");
    const titleElement = doc?.querySelector(".item-summary-view-metadata h2");
    const bookActualName = titleElement?.textContent?.trim() || "";

    const url = isLinkToBookPage
      ? usersUrl.replace("xmlui/handle/asu/", "xmlui/bitstream/handle/asu/") +
        "read.7book"
      : usersUrl;

    // Handle direct book viewer URLs
    if (url.includes("/els/files/book")) {
      const params = new URL(url).searchParams;
      const bookId = params.get("id");
      const bookName = params.get("name");

      if (!bookId || !bookName) {
        throw new Error("Invalid book URL: missing id or name parameters");
      }

      return { bookId, bookName, bookActualName };
    }

    // Handle library catalog URLs
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch page: ${response.status}`);
    }

    const html = await response.text();

    // Look for the frame source URL
    const frameMatch = html.match(
      /\/els\/files\/book\?id=([^&]+)&name=([^"&]+)/,
    );
    if (!frameMatch) {
      throw new Error("Could not find book viewer URL in the page");
    }

    const [, bookId, bookName] = frameMatch;
    return { bookId, bookName, bookActualName };
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Failed to parse book URL: ${error.message}`);
    }
    throw new Error("Failed to parse book URL: Unknown error");
  }
}

if (import.meta.main) {
  parseBookUrl("http://elibrary.asu.ru/xmlui/handle/asu/9770/");
}
