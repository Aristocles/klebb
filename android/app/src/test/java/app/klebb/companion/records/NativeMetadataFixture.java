// SPDX-License-Identifier: AGPL-3.0-only
package app.klebb.companion.records;

import androidx.health.connect.client.records.metadata.DataOrigin;
import androidx.health.connect.client.records.metadata.Device;
import androidx.health.connect.client.records.metadata.Metadata;
import java.time.Instant;

/** Test-only access to the SDK's compiled public constructor, not reflection. */
final class NativeMetadataFixture {
    static Metadata full() {
        return fullWithRecordingMethod(2);
    }

    static Metadata fullWithRecordingMethod(int method) {
        return create(method, "synthetic-provider-id",
            "2001-10-29T03:04:05.987654321Z", "synthetic-client-id/\u03b1\n\"quoted\"",
            9007199254740993L, new Device(1, "Synthetic maker", "Synthetic model \u0394"));
    }

    static Metadata nullable() {
        return create(0, "synthetic-provider-id-nullable",
            "1970-01-01T00:00:00Z", null, 0, null);
    }

    static Metadata nullableDeviceFields() {
        return create(3, "synthetic-provider-id-device-null-fields",
            "2001-10-29T03:04:05.000000001Z", "", Long.MAX_VALUE,
            new Device(0, null, null));
    }

    static Metadata create(int method, String id, String modified, String clientId,
                           long version, Device device) {
        return new Metadata(method, id, new DataOrigin("org.example.synthetic.producer"),
            Instant.parse(modified), clientId, version, device);
    }
}
