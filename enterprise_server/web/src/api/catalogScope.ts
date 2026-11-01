/**
 * The authorization grant a catalog entry is visible to.
 *
 * A scope is a GRANT, never a deny: the whole company, a set of departments,
 * and a set of member exceptions. The skill, kit, connector and agent
 * catalogs all use this shape.
 */
export interface CatalogScope {
  allCompany: boolean;
  deptIds: string[];
  userIds: string[];
}
