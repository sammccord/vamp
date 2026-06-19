export const entityTemplate = `import "../node_modules/@vamp/utils/schema/pool.bop"
import "./tags.bop"

message Entity {
\t1 -> guid id;
\t2 -> guid root;
\t3 -> Tags[] tags;
\t4 -> guid parent;
\t5 -> guid[] children;
\t6 -> Pool health;
}
`;
