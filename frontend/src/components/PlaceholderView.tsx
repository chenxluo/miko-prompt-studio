interface PlaceholderViewProps {
  title: string;
  description?: string;
}

export function PlaceholderView({ title, description }: PlaceholderViewProps) {
  return (
    <div className="flex h-full flex-col items-center justify-center p-8 text-center animate-fade-in">
      <div className="panel max-w-md p-8">
        <h2 className="mb-2 text-2xl font-semibold tracking-tight text-ink">{title}</h2>
        {description && (
          <p className="text-sm leading-relaxed text-ink-muted">{description}</p>
        )}
      </div>
    </div>
  );
}
