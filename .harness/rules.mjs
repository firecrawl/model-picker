export default {
  meta: { name: "harness" },
  rules: {
    "max-lines": {
      meta: { type: "suggestion", schema: [{ type: "integer" }] },
      create(context) {
        const max = context.options[0] ?? 300;
        return {
          Program(node) {
            const lines = context.sourceCode.lines.length;
            if (lines > max) {
              context.report({
                node,
                message: `File is ${lines} lines (max ${max}). Split it into modules under src/features/<name>/ instead of growing it.`,
              });
            }
          },
        };
      },
    },
    "no-as-cast": {
      meta: { type: "problem", schema: [] },
      create(context) {
        return {
          TSAsExpression(node) {
            const t = node.typeAnnotation;
            if (t.type === "TSTypeReference" && t.typeName.name === "const") return;
            context.report({ node, message: "No `as` casts. Narrow with a type guard or parse the value (e.g. zod) instead." });
          },
        };
      },
    },
    "no-console": {
      meta: { type: "suggestion", schema: [] },
      create(context) {
        return {
          MemberExpression(node) {
            if (node.object.type === "Identifier" && node.object.name === "console") {
              context.report({ node, message: "No console. Use the project logger." });
            }
          },
        };
      },
    },
  },
};
