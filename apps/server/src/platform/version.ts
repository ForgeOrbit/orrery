// Set at image build time (ORRERY_VERSION build arg); "dev" otherwise.
export const version = process.env.ORRERY_VERSION ?? "dev";
