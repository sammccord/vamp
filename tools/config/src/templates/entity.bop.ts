export const entityTemplate = `import "../node_modules/@framework/utils/schema/pool.bop"

message Entity {
\t1 -> guid id;
\t2 -> guid root;
\t3 -> guid parent;
\t4 -> guid[] children;
\t5 -> pool health;
}
`;
