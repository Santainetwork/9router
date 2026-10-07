"use client";

import { cn } from "@/shared/utils/cn";

export default function Avatar({
  src,
  alt = "Avatar",
  name,
  size = "md",
  className,
}) {
  const sizes = {
    xs: "size-6 text-xs",
    sm: "size-8 text-sm",
    md: "size-10 text-base",
    lg: "size-12 text-lg",
    xl: "size-16 text-xl",
  };

  // Get initials from name
  const getInitials = (name) => {
    if (!name) return "?";
    const parts = name.split(" ");
    if (parts.length >= 2) {
      return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
    }
    return name.substring(0, 2).toUpperCase();
  };

  // Generate color from name
  const getColorFromName = (name) => {
    if (!name) return "bg-primary/10 text-primary";
    const colors = [
      "bg-danger/15 text-danger",
      "bg-warning/15 text-warning",
      "bg-success/15 text-success",
      "bg-info/15 text-info",
      "bg-primary/10 text-primary",
      "bg-surface-3 text-text-main",
    ];
    const index = name.charCodeAt(0) % colors.length;
    return colors[index];
  };

  if (src) {
    return (
      <div
        className={cn(
          "rounded-full bg-cover bg-center bg-no-repeat",
          "ring-2 ring-border shadow-soft",
          sizes[size],
          className
        )}
        style={{ backgroundImage: `url(${src})` }}
        role="img"
        aria-label={alt}
      />
    );
  }

  return (
    <div
      className={cn(
        "rounded-full flex items-center justify-center font-semibold",
        "ring-2 ring-border shadow-soft",
        sizes[size],
        getColorFromName(name),
        className
      )}
      role="img"
      aria-label={alt}
    >
      {getInitials(name)}
    </div>
  );
}

