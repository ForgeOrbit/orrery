import { Link as AstryxLink, type LinkProps } from "@astryxdesign/core/Link";
import { createLink } from "@tanstack/react-router";

function ThemedLink(props: LinkProps) {
  return <AstryxLink type="inherit" color="inherit" {...props} />;
}

export const Link = createLink(ThemedLink);
