// Function to handle converting a string to camelCase
export function stringToCamelCase(str: string): string {
    return str
        .toLowerCase()
        .split("_")
        .map((s, i) =>
            i === 0 ? s : s.slice(0, 1).toUpperCase() + s.slice(1, s.length)
        )
        .join("");
}

// Function to handle converting a string to snake_case
export function stringToSnakeCase(str: string): string {
    return str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

// Function to handle switching API data response objects into camelCase
export function objToCamelCase(obj: any): any {
    if (!obj) {
        return obj;
    }

    if (Array.isArray(obj)) {
        return obj.map((entry) =>
            typeof entry !== "object" ? entry : objToCamelCase(entry)
        );
    }

    const newObj = Object.entries(obj).reduce((acc: any, [key, value]) => {
        const newKey = stringToCamelCase(key);
        const newValue = typeof value !== "object" ? value : objToCamelCase(value);
        acc[newKey] = newValue;
        return acc;
    }, {});

    return newObj;
}

// Function to handle switching objects into snake_case
export function objToSnakeCase(obj: any): any {
    if (!obj) {
        return obj;
    }

    if (obj instanceof File || obj instanceof FormData) {
        return obj;
    }

    if (Array.isArray(obj)) {
        return obj.map((entry) =>
            typeof entry !== "object" ? entry : objToSnakeCase(entry)
        );
    }

    const newObj = Object.entries(obj).reduce((acc: any, [key, value]) => {
        const newKey = stringToSnakeCase(key);
        const newValue = typeof value !== "object" ? value : objToSnakeCase(value);
        acc[newKey] = newValue;
        return acc;
    }, {});

    return newObj;
}
