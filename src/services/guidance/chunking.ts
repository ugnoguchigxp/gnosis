export const uniqueStrings = (values: string[]): string[] =>
  Array.from(new Set(values.map((value) => value.trim()).filter((value) => value.length > 0)));

const hardSplitText = (text: string, maxChars: number): string[] => {
  if (text.length <= maxChars) return [text];
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += maxChars) {
    chunks.push(text.slice(index, index + maxChars));
  }
  return chunks;
};

export const splitMarkdownIntoChunks = (
  markdown: string,
  docTitle: string,
  maxChunkChars: number,
): Array<{ title: string; content: string }> => {
  const normalized = markdown.replaceAll('\r\n', '\n').trim();
  if (normalized.length === 0) return [];

  const lines = normalized.split('\n');
  const sections: Array<{ title: string; content: string }> = [];
  let currentTitle = docTitle;
  let currentLines: string[] = [];

  const flushSection = () => {
    const content = currentLines.join('\n').trim();
    if (content.length > 0) {
      sections.push({
        title: currentTitle,
        content,
      });
    }
    currentLines = [];
  };

  for (const line of lines) {
    const heading = line.match(/^#{1,6}\s+(.+?)\s*$/);
    if (heading) {
      flushSection();
      currentTitle = heading[1] ? `${docTitle} / ${heading[1]}` : docTitle;
      currentLines.push(line);
      continue;
    }
    currentLines.push(line);
  }
  flushSection();

  if (sections.length === 0) {
    sections.push({ title: docTitle, content: normalized });
  }

  const chunks: Array<{ title: string; content: string }> = [];
  for (const section of sections) {
    const paragraphs = section.content
      .split(/\n{2,}/)
      .map((paragraph) => paragraph.trim())
      .filter((paragraph) => paragraph.length > 0);

    if (paragraphs.length === 0) continue;

    let current = '';
    for (const paragraph of paragraphs) {
      if (paragraph.length > maxChunkChars) {
        if (current.length > 0) {
          chunks.push({ title: section.title, content: current });
          current = '';
        }
        const parts = hardSplitText(paragraph, maxChunkChars);
        for (const part of parts) {
          chunks.push({ title: section.title, content: part });
        }
        continue;
      }

      const next = current.length === 0 ? paragraph : `${current}\n\n${paragraph}`;
      if (next.length > maxChunkChars) {
        chunks.push({ title: section.title, content: current });
        current = paragraph;
        continue;
      }
      current = next;
    }

    if (current.length > 0) {
      chunks.push({ title: section.title, content: current });
    }
  }

  return chunks;
};
