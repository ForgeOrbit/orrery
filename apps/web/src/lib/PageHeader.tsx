import { Heading } from "@astryxdesign/core/Heading";
import { Icon } from "@astryxdesign/core/Icon";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import type { ReactNode } from "react";
import { Fragment } from "react";

export interface PageHeaderProps {
  breadcrumbs?: ReactNode[];
  title: ReactNode;
  badge?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}

export function PageHeader({ breadcrumbs, title, badge, subtitle, actions }: PageHeaderProps) {
  return (
    <header className="page-header">
      {breadcrumbs !== undefined && breadcrumbs.length > 0 && (
        <nav className="page-breadcrumbs" aria-label="Breadcrumb">
          {breadcrumbs.map((crumb, index) => (
            // oxlint-disable-next-line react/no-array-index-key -- static ordered breadcrumb segments
            <Fragment key={index}>
              {index > 0 && <Icon icon="chevronRight" size="xsm" />}
              {crumb}
            </Fragment>
          ))}
        </nav>
      )}
      <Stack direction="horizontal" className="page-header-row">
        <Stack className="page-header-main">
          <Stack direction="horizontal" className="page-header-title-row">
            <Heading level={1} color="inherit">
              {title}
            </Heading>
            {badge !== undefined && <span className="meta-pill">{badge}</span>}
          </Stack>
          {subtitle !== undefined && (
            <Text as="p" display="block" type="supporting" className="page-header-subtitle">
              {subtitle}
            </Text>
          )}
        </Stack>
        {actions !== undefined && (
          <Stack direction="horizontal" className="page-header-actions">
            {actions}
          </Stack>
        )}
      </Stack>
    </header>
  );
}
