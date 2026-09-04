import ModelProbeClient from "./ModelProbeClient";

export const metadata = {
  title: "Model Identity Probe - 9Router",
  description: "Verify upstream model authenticity and detect silent model swap with BazaarLink Probe API",
};

export default function ModelProbePage() {
  return <ModelProbeClient />;
}
