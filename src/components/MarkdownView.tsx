import Markdown from 'react-markdown'

// Trusted local content (the project's own pipeline artifacts). react-markdown
// does NOT render raw HTML by default — no rehype-raw is wired in on purpose.
export function MarkdownView({ content }: { content: string }) {
  return (
    <div className="md">
      <Markdown>{content}</Markdown>
    </div>
  )
}
