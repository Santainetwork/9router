import * as React from "react";
import { cva } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 select-none",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-primary/10 text-primary border-primary/20",
        secondary:
          "border-transparent bg-surface-2 text-text-muted hover:bg-surface-3",
        destructive:
          "border-transparent bg-danger/10 text-danger border-danger/20",
        outline: "text-text-main border-border",
        success:
          "border-transparent bg-success/15 text-success border-success/30",
        warning:
          "border-transparent bg-warning/10 text-warning border-warning/30",
        neoYellow:
          "rounded-md border-2 border-black dark:border-white bg-warning/15 text-black font-black uppercase tracking-wider shadow-[2px_2px_0px_#000] dark:shadow-[2px_2px_0px_#fff]",
        neoCyan:
          "rounded-md border-2 border-black dark:border-white bg-info/15 text-black font-black uppercase tracking-wider shadow-[2px_2px_0px_#000] dark:shadow-[2px_2px_0px_#fff]",
        neoPink:
          "rounded-md border-2 border-black dark:border-white bg-surface-3 text-black font-black uppercase tracking-wider shadow-[2px_2px_0px_#000] dark:shadow-[2px_2px_0px_#fff]",
        neoGreen:
          "rounded-md border-2 border-black dark:border-white bg-success/15 text-black font-black uppercase tracking-wider shadow-[2px_2px_0px_#000] dark:shadow-[2px_2px_0px_#fff]",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
);

function Badge({ className, variant, ...props }) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
