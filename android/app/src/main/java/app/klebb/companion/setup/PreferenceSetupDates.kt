// SPDX-License-Identifier: AGPL-3.0-only
package app.klebb.companion.setup

import android.annotation.SuppressLint
import android.content.Context
import android.content.SharedPreferences

internal object PreferenceSetupDates {
    const val FILE = "capture-date-choices"
    const val KEY = "complete-value"

    fun open(context: Context): SetupDateStore = from(
        context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE)
    )

    @SuppressLint("ApplySharedPref") // The result must confirm the synchronous disk write.
    fun from(preferences: SharedPreferences): SetupDateStore = SetupDateStore(
        { preferences.getString(KEY, null) },
        { value -> preferences.edit().putString(KEY, value).commit() }
    )
}
