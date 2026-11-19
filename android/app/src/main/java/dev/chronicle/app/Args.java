package dev.chronicle.app;

import com.getcapacitor.PluginCall;

/**
 * Numbers from the web side. A JSON number arrives as an Integer when it fits in 32 bits, a Long when it does not and
 * a Double when it has a fraction or an exponent – and PluginCall.getLong answers only for a Long: a small whole number
 * (a calendar id, a size under 2 GB) silently became the default.
 */
final class Args {
    private Args() {}

    /** The whole number under name, whatever JSON made of it; null when it is missing or not a number. */
    static Long whole(PluginCall call, String name) {
        Object v = call.getData().opt(name);
        if (v instanceof Number) {
            double d = ((Number) v).doubleValue();
            if (Double.isNaN(d) || Double.isInfinite(d)) return null;
            return (v instanceof Double || v instanceof Float) ? Math.round(d) : ((Number) v).longValue();
        }
        return null;
    }

    static long whole(PluginCall call, String name, long fallback) {
        Long v = whole(call, name);
        return v == null ? fallback : v;
    }
}
