export const actionsTemplate = `union Actions {
\t1 -> message Attack {
\t\t1 -> guid source;
\t\t2 -> guid target;
\t\t3 -> uint32 damage;
\t}
}
`;
