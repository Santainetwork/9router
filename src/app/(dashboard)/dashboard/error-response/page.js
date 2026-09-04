import ErrorResponseClient from "./ErrorResponseClient";

export const metadata = {
  title: "Custom Error Response - 9Router",
  description: "Configure custom human-friendly OpenAI error responses for upstream failures",
};

export default function ErrorResponsePage() {
  return <ErrorResponseClient />;
}
