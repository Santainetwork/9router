"use client";

import { useState } from "react";
import PropTypes from "prop-types";
import { getProviderIconSrc, markProviderIconMissing } from "@/shared/utils/providerIcon";

function resolveSrc(src, providerId) {
  if (providerId) return getProviderIconSrc(providerId);
  if (!src) return null;
  const m = String(src).match(/^\/providers\/([^/]+)\.png$/i);
  if (m) return getProviderIconSrc(m[1]);
  return src;
}

export default function ProviderIcon({
  src,
  providerId,
  provider,
  alt,
  size = 32,
  className = "",
  fallbackText,
  fallbackColor,
}) {
  const targetId = providerId || provider;
  const effectiveSrc = resolveSrc(src, targetId);
  const [errored, setErrored] = useState(false);

  if (!effectiveSrc || errored) {
    const rawInitial = (fallbackText || targetId || alt || "?")
      .replace(/^https?:\/\//i, "")
      .replace(/[^a-zA-Z0-9]/g, "")
      .slice(0, 2)
      .toUpperCase();
    const displayText = fallbackText || rawInitial || "?";

    return (
      <span
        className={`inline-flex items-center justify-center font-bold font-mono rounded-lg bg-surface-2 text-text-muted border border-border/80 shrink-0 ${className}`.trim()}
        style={{
          width: size,
          height: size,
          color: fallbackColor,
          fontSize: Math.max(9, Math.floor(size * 0.38)),
        }}
        title={alt || targetId || ""}
      >
        {displayText}
      </span>
    );
  }

  return (
    <img
      src={effectiveSrc}
      alt={alt || targetId || "Provider icon"}
      width={size}
      height={size}
      className={className}
      loading="lazy"
      decoding="async"
      onError={() => {
        const m = effectiveSrc.match(/^\/providers\/([^/]+)\.png$/i);
        if (m) markProviderIconMissing(m[1]);
        if (targetId) markProviderIconMissing(targetId);
        setErrored(true);
      }}
    />
  );
}

ProviderIcon.propTypes = {
  src: PropTypes.string,
  providerId: PropTypes.string,
  provider: PropTypes.string,
  alt: PropTypes.string,
  size: PropTypes.number,
  className: PropTypes.string,
  fallbackText: PropTypes.string,
  fallbackColor: PropTypes.string,
};
