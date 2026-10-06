"use client";

/** Reusable status alert */
export default function StatusAlert({ status, className = "" }) {
  const renderMessage = (msg) => {
    const parts = msg.split(/(https?:\/\/[^\s]+)/g);
    return parts.map((part, i) =>
      /^https?:\/\//.test(part)
        ? <a key={i} href={part} target="_blank" rel="noreferrer" className="underline font-medium">{part}</a>
        : part
    );
  };

  return (
    <div className={`p-2 rounded text-sm ${className} ${status.type === "success" ? "bg-green-500/10 text-green-800 dark:text-green-400" :
        status.type === "warning" ? "bg-yellow-500/10 text-yellow-800 dark:text-yellow-400" :
        status.type === "info" ? "bg-blue-500/10 text-blue-700 dark:text-blue-300" :
          "bg-red-500/10 text-red-800 dark:text-red-300"
      }`}>
      {renderMessage(status.message)}
    </div>
  );
}
